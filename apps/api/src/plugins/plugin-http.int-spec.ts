import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

/**
 * The plugin endpoints over HTTP, through the Fastify bridge.
 *
 * These have to be exercised through a real router rather than by calling the
 * controllers: the surface is entirely made of wildcard routes, a guard, and a
 * path that is joined onto a directory, and none of those three has any
 * meaning when the handler is called directly.
 *
 * The plugin is installed before the application boots, because the loader
 * runs once at start-up - which is the whole reason installing one ends by
 * replacing the process.
 */

const run = promisify(execFile);
const env = loadEnvForIntegrationTests();

function repositoryRoot(): string {
  const { root } = parse(process.cwd());
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }
    if (directory === root) {
      return process.cwd();
    }
    directory = dirname(directory);
  }
}

const REPO_ROOT = repositoryRoot();
const CATALOG = join(REPO_ROOT, "fixtures", "catalog", "catalog.json");
const PLUGIN_ID = "occupancy";

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const admin = {
  personId: `plugin-admin-${suffix}`,
  email: `plugin-admin-${suffix}@exempel.se`,
};
const outsider = {
  personId: `plugin-outsider-${suffix}`,
  email: `plugin-outsider-${suffix}@exempel.se`,
};

let app: NestFastifyApplication;
let prisma: PrismaService;
let workspace: string;
let previousDataDir: string | undefined;
let previousCatalogUrl: string | undefined;
let previousUncurated: string | undefined;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": `10.7.0.${String(ipCounter % 250)}`,
        ...options.headers,
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

async function ensureFixture(): Promise<void> {
  try {
    await access(CATALOG);
    return;
  } catch {
    // Not built yet.
  }
  await run("node", [join(REPO_ROOT, "scripts", "build-fixture-catalog.mjs")], {
    cwd: REPO_ROOT,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

let adminCookie: string;
let outsiderCookie: string;

beforeAll(async () => {
  await ensureFixture();

  workspace = await mkdtemp(join(tmpdir(), "openbrf-plugin-http-"));

  // Set before the application context is built: the configuration module
  // reads the environment once, at start-up.
  previousDataDir = process.env.OPENBRF_DATA_DIR;
  previousCatalogUrl = process.env.OPENBRF_CATALOG_URL;
  previousUncurated = process.env.OPENBRF_UNCURATED_PLUGINS_ENABLED;
  process.env.OPENBRF_DATA_DIR = workspace;
  process.env.OPENBRF_CATALOG_URL = pathToFileURL(CATALOG).href;
  process.env.OPENBRF_UNCURATED_PLUGINS_ENABLED = "true";

  const testEnv = {
    ...env,
    OPENBRF_DATA_DIR: workspace,
    OPENBRF_PLUGINS_ENABLED: true,
    OPENBRF_CATALOG_URL: pathToFileURL(CATALOG).href,
    OPENBRF_UNCURATED_PLUGINS_ENABLED: true,
  };

  // Install before boot, standing in for the restart an install ends with.
  const bootstrapModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const registry = bootstrapModule.get(PluginRegistryService);
  const catalog = new CatalogClient(testEnv);
  const entry = (await catalog.entry(PLUGIN_ID)) as CatalogPluginEntry;

  await registry.consent({
    id: entry.id,
    packageName: entry.packageName,
    version: entry.version,
    tarballUrl: entry.artifact.url,
    checksum: entry.artifact.sha512,
    permissions: entry.permissions,
    personalData: entry.personalData,
  });

  await new PluginInstallerService(
    testEnv,
    registry,
    new JobQueueService(testEnv),
    catalog,
    new RestartCoordinator(testEnv),
    { needsReconcile: () => false } as never,
  ).reconcile();
  await bootstrapModule.close();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  const auth = app.get(AuthService);

  for (const person of [admin, outsider]) {
    await prisma.person.create({
      data: {
        id: person.personId,
        firstName: "Test",
        lastName: `Plugin${suffix}`,
        preferredLocale: "sv",
      },
    });
    await auth.createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  await prisma.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });

  adminCookie = await signIn(admin.email);
  outsiderCookie = await signIn(outsider.email);
}, 420_000);

afterAll(async () => {
  const personIds = [admin.personId, outsider.personId];
  await prisma.systemRole.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
  await app.close();

  process.env.OPENBRF_DATA_DIR = previousDataDir;
  process.env.OPENBRF_CATALOG_URL = previousCatalogUrl;
  process.env.OPENBRF_UNCURATED_PLUGINS_ENABLED = previousUncurated;
  await rm(workspace, { recursive: true, force: true });
});

describe("the plugin administration endpoints", () => {
  it("lists the installed plugin as loaded", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugins",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pluginsEnabled: true,
      plugins: [{ id: PLUGIN_ID, loaded: true, enabled: true }],
    });
  });

  it("offers the catalog to an admin", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugins/catalog",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entries: [{ id: PLUGIN_ID, supported: true, installedVersion: "1.0.0" }],
    });
  });

  it("refuses the catalog to an account that may not manage the instance", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugins/catalog",
      headers: { cookie: outsiderCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("reads and writes the plugin's settings against its declaration", async () => {
    const read = await inject({
      method: "GET",
      url: `/api/plugins/${PLUGIN_ID}/settings`,
      headers: { cookie: adminCookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ values: { heading: "Occupancy" } });

    const written = await inject({
      method: "PUT",
      url: `/api/plugins/${PLUGIN_ID}/settings`,
      headers: { cookie: adminCookie },
      payload: {
        values: {
          heading: "Belaggning",
          rowLimit: 10,
          showMembers: true,
          grouping: "floor",
        },
      },
    });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ values: { rowLimit: 10 } });
  });

  it("refuses a settings value the declaration does not allow", async () => {
    const response = await inject({
      method: "PUT",
      url: `/api/plugins/${PLUGIN_ID}/settings`,
      headers: { cookie: adminCookie },
      // The manifest caps rowLimit at 200 and requires an integer.
      payload: { values: { rowLimit: 5000 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ reason: "invalid-body" });
  });
});

describe("a plugin's own routes", () => {
  it("serves the route the plugin declared", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/summary`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: { apartments: expect.any(Number) },
    });
  });

  it("answers 404 for a path the plugin does not serve", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/does-not-exist`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      reason: "plugin-route-not-found",
    });
  });

  it("requires a session", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/summary`,
    });

    expect(response.statusCode).toBe(401);
  });

  /**
   * The capability floor. The plugin declared no capability on its route, and
   * it reads the register - so a signed-in account that may not read the
   * address book must not reach it through the plugin either.
   */
  it("refuses a caller below the floor its permissions imply", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/summary`,
      headers: { cookie: outsiderCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "plugin-forbidden" });
  });

  it("answers 404 for a plugin that is not installed", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugin/not-installed/summary",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("a plugin's frontend bundle", () => {
  it("serves the remote entry", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugins/${PLUGIN_ID}/client/remoteEntry.js`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.body.length).toBeGreaterThan(0);
  });

  /**
   * The package is a tarball somebody else built. Serving its frontend must
   * not turn the rest of it into files hosted on the association's domain.
   */
  it("does not serve the plugin's own manifest", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugins/${PLUGIN_ID}/client/../package.json`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not serve a file type that is not part of a frontend bundle", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugins/${PLUGIN_ID}/client/server.cjs`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugins/${PLUGIN_ID}/client/remoteEntry.js`,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("a plugin's translations", () => {
  it("serves the merged bundle for each locale", async () => {
    const swedish = await inject({
      method: "GET",
      url: `/api/i18n/sv/plugin-${PLUGIN_ID}`,
      headers: { cookie: adminCookie },
    });
    const english = await inject({
      method: "GET",
      url: `/api/i18n/en/plugin-${PLUGIN_ID}`,
      headers: { cookie: adminCookie },
    });

    expect(swedish.statusCode).toBe(200);
    expect(english.statusCode).toBe(200);
    expect(swedish.json()).not.toEqual({});
    // Two languages, so the merge is per locale rather than one bundle serving
    // both.
    expect(swedish.json()).not.toEqual(english.json());
  });

  /**
   * i18next asks for a namespace whenever a component references one,
   * including in the moment after a plugin is disabled and before its view
   * unmounts. A 404 there would be a console error about a state that is
   * already correct.
   */
  it("answers with an empty bundle for a namespace it does not have", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/i18n/sv/plugin-not-installed",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it("is offered to any signed-in account, not only an admin", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/i18n/sv/plugin-${PLUGIN_ID}`,
      headers: { cookie: outsiderCookie },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("the plugin views endpoint", () => {
  it("lists the view for any signed-in account", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugin-views",
      headers: { cookie: outsiderCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      views: [
        {
          id: PLUGIN_ID,
          remoteEntry: `/api/plugins/${PLUGIN_ID}/client/remoteEntry.js`,
        },
      ],
    });
  });
});

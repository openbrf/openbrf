import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import type { ProtectedResource } from "../auth/protected-resource";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
} from "../testing/integration-env";
import { PluginAdminService } from "./plugin-admin.service";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

/**
 * The plugin endpoints over HTTP, through the Fastify bridge.
 *
 * These have to be exercised through a real router rather than by calling the
 * controllers: what is under test is a plugin's own NestJS controllers sitting
 * inside the application's global guard at a capability floor the host raised,
 * and none of that has any meaning when a handler is called directly.
 *
 * The application is started through the same bootstrap the process uses,
 * rather than by assembling a container here: the boot sequence - bridge,
 * load, build, bind - is itself the thing under test, and a harness that
 * assembled its own would be testing something else.
 *
 * The plugin is installed before the application boots, because plugins are
 * loaded once at start-up - which is the whole reason installing one ends by
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

/**
 * The route the fixture's manifest declares as the OAuth protected resource,
 * and one path beneath it.
 *
 * Written out here rather than read back from the resolved resource, because
 * the agreement between the two is the property under test: the manifest's
 * `oauthProtectedResource`, what `resolveProtectedResource` made of it, and the
 * path the module seal actually mounted the controller on are three decisions
 * taken in three different places, and the guard's Bearer branch only fires
 * where all three meet. A constant derived from one of them could not fail.
 */
const RESOURCE_PATH = `/api/plugin/${PLUGIN_ID}/mcp`;
const RESOURCE_SUB_PATH = `${RESOURCE_PATH}/messages`;
/** A route of the same plugin the manifest says nothing about. */
const SIBLING_PATH = `/api/plugin/${PLUGIN_ID}/summary`;

/** What a token for this resource may carry, per the sign-in options. */
const SCOPES = ["mcp:read", "mcp:write"];

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
/** The connected app the tokens below are issued to. */
const connectedApp = `https://klient-${suffix}.exempel.se/id`;

let app: NestFastifyApplication | undefined;
let prisma: PrismaService | undefined;
let workspace: string | undefined;
let previousDataDir: string | undefined;
let previousCatalogUrl: string | undefined;
let previousUncurated: string | undefined;

/**
 * The running application.
 *
 * Held as optional and asked for through here rather than assumed present, so
 * the teardown can tell "never started" from "would not close" - the one being
 * a setup failure already in the report, the other a started application that
 * a passing run would otherwise leave behind.
 */
function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  return application()
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": `10.56.0.${String(ipCounter % 250)}`,
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

/** The resource this process resolved, as the three injectors read it. */
function resolvedResource(): ProtectedResource {
  return application().get<ProtectedResource>(PROTECTED_RESOURCE);
}

/**
 * Writes the rows an authorization would have written.
 *
 * The flow itself needs a browser and a client that can be redirected to, and
 * none of that is what this suite is about: what it needs is a token row that
 * really exists, so that what reaches the plugin's route is a credential the
 * resolver found rather than a stub.
 *
 * Two things it must not fake. The digest, because the column holds
 * `hashOpaqueToken(value)` and never the value - a row written with the
 * plaintext is a row the resolver can never find, and every assertion below
 * would then fail for a reason that has nothing to do with the guard. And the
 * audience, because a token is only accepted where its `resources` carry this
 * instance's own resource URL, which is read from the resolved resource here
 * for the same reason the paths above are not.
 *
 * The refresh row `connected-apps.int-spec.ts` also writes is left out: it is
 * what keeps a fifteen-minute access token usable, and nothing on this path
 * reads it.
 */
async function grant(options: {
  personId: string;
  token: string;
}): Promise<void> {
  const client = application().get(PrismaService);
  const account = await client.user.findUniqueOrThrow({
    where: { personId: options.personId },
    select: { id: true },
  });
  const audience = [resolvedResource().url];
  const now = new Date();

  await client.oauthClient.upsert({
    where: { clientId: connectedApp },
    create: {
      clientId: connectedApp,
      name: "En ansluten app",
      clientDiscoveryId: connectedApp,
      scopes: SCOPES,
      contacts: [],
      redirectUris: [`${new URL(connectedApp).origin}/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      createdAt: now,
      updatedAt: now,
    },
    update: {},
  });

  await client.oauthConsent.create({
    data: {
      clientId: connectedApp,
      userId: account.id,
      resources: audience,
      requestedUserInfoClaims: [],
      scopes: SCOPES,
      createdAt: now,
      updatedAt: now,
    },
  });

  await client.oauthAccessToken.create({
    data: {
      token: hashOpaqueToken(options.token),
      clientId: connectedApp,
      userId: account.id,
      resources: audience,
      requestedUserInfoClaims: [],
      scopes: SCOPES,
      expiresAt: new Date(Date.now() + 900_000),
      createdAt: now,
    },
  });
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

  const created = await mkdtemp(join(tmpdir(), "openbrf-plugin-http-"));
  workspace = created;

  // Set before the application context is built: the configuration module
  // reads the environment once, at start-up.
  previousDataDir = process.env.OPENBRF_DATA_DIR;
  previousCatalogUrl = process.env.OPENBRF_CATALOG_URL;
  previousUncurated = process.env.OPENBRF_UNCURATED_PLUGINS_ENABLED;
  process.env.OPENBRF_DATA_DIR = created;
  process.env.OPENBRF_CATALOG_URL = pathToFileURL(CATALOG).href;
  process.env.OPENBRF_UNCURATED_PLUGINS_ENABLED = "true";

  const testEnv = {
    ...env,
    OPENBRF_DATA_DIR: created,
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
    actions: entry.actions,
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

  // The boot the supervisor performs after an install: load what is on the
  // volume, build the application around it, bind the host objects.
  const started = await createApplication(await loadPluginsAtBoot(testEnv));
  app = started;
  await started.init();
  await started.getHttpAdapter().getInstance().ready();

  const client = started.get(PrismaService);
  prisma = client;
  const auth = started.get(AuthService);

  for (const person of [admin, outsider]) {
    await client.person.create({
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

  await client.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });

  adminCookie = await signIn(admin.email);
  outsiderCookie = await signIn(outsider.email);
}, 420_000);

afterAll(async () => {
  /*
   * beforeAll builds a fixture, a workspace, a database client and an
   * application in that order and can fail at any of them, so each of those
   * is asked for before it is used. Nothing beyond that is guarded, and
   * deliberately: a deletion, a close or a removal that fails is a real
   * failure of this run. Integration files run one at a time against one
   * database and one temporary directory, so a person, an installed-plugin
   * row, a listening application or a workspace left behind is there for
   * whatever runs next - and a catch here would report that as a green run.
   *
   * Everything that has to happen whatever the deletions did is in `finally`:
   * closing the application, restoring the environment the next suite in this
   * worker reads, and removing the workspace.
   */
  try {
    if (prisma !== undefined) {
      const personIds = [admin.personId, outsider.personId];
      // First, because every consent and token this suite wrote hangs off it
      // by clientId and goes with it.
      await prisma.oauthClient.deleteMany({
        where: { clientId: connectedApp },
      });
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
    }
  } finally {
    try {
      if (app !== undefined) {
        await app.close();
      }
    } finally {
      restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
      restoreEnvironmentVariable("OPENBRF_CATALOG_URL", previousCatalogUrl);
      restoreEnvironmentVariable(
        "OPENBRF_UNCURATED_PLUGINS_ENABLED",
        previousUncurated,
      );
      if (workspace !== undefined) {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }
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

describe("a plugin's own controllers", () => {
  /**
   * A NestJS controller from the plugin's bundle, constructed by the
   * application's own injector: the answer comes from an injected provider,
   * so dependency injection resolved against the one NestJS instance the
   * resolution bridge exists to guarantee.
   */
  it("serves the routes the plugin's controller declared", async () => {
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

  /**
   * The late binding, seen from the outside. `startedWith` is what the
   * plugin's provider read from the host in its own onModuleInit - so the host
   * object was answering by the time the application's lifecycle hooks ran,
   * which is the whole of what the contract promises a plugin author.
   */
  it("ran the plugin's lifecycle hook against a live host", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/summary`,
      headers: { cookie: adminCookie },
    });

    expect(response.json()).toMatchObject({ startedWith: expect.any(String) });
  });

  /** A guard the plugin declared, running in addition to the host's. */
  it("applies the plugin's own guard", async () => {
    const allowed = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/apartments?grouping=floor`,
      headers: { cookie: adminCookie },
    });
    const refused = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/apartments?grouping=nonsense`,
      headers: { cookie: adminCookie },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ grouping: "floor" });
    expect(refused.statusCode).toBe(403);
  });

  it("answers 404 for a path the plugin does not serve", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/does-not-exist`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/summary`,
    });

    expect(response.statusCode).toBe(401);
  });

  /**
   * The capability floor, enforced by the application's own guard rather than
   * by anything the plugin can reach. The plugin declared no capability on its
   * routes and it reads the register, so a signed-in account that may not read
   * the address book must not reach it through the plugin either.
   */
  it("refuses a caller below the floor its permissions imply", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/summary`,
      headers: { cookie: outsiderCookie },
    });

    expect(response.statusCode).toBe(403);
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

/**
 * The route this plugin's manifest declared as the OAuth protected resource.
 *
 * This is the one thing about that route no unit test can establish, because it
 * holds only if three decisions taken in three different places agree at boot:
 * the installed manifest declaring `oauthProtectedResource`,
 * `resolveProtectedResource` picking that up from the plugins this process
 * actually loaded, and the module seal mounting the plugin's controller on the
 * path the first two named. The guard's branch is driven by the resolved path
 * alone and by nothing about the route itself, so if any of the three disagrees
 * the branch never fires - and what is then answering at the connector's
 * address is an ordinary plugin route, reachable with the session cookie the
 * member's own browser already holds. Nothing that tests the guard against a
 * resource it was handed can see that, which is why the first assertion below
 * presents the cookie rather than a token.
 *
 * The plugin is installed from a real tarball and loaded by the real boot
 * sequence, above, so each of the three is the one the process would use.
 */
describe("the plugin route declared as the OAuth protected resource", () => {
  it("is the route the installed manifest names, at the path it is mounted on", () => {
    const resource = resolvedResource();

    // `declared` is what arms the branch at all: an instance with no connector
    // advertises a default path, mounts nothing on it, and installs no branch.
    expect(resource.declared).toBe(true);
    expect(resource.path).toBe(RESOURCE_PATH);
    expect(resource.url).toBe(new URL(RESOURCE_PATH, env.APP_URL).toString());
  });

  /**
   * The assertion the rest of this file exists to make possible.
   *
   * The sibling is presented in the same test and with the same cookie, for two
   * reasons. It is the control: a 401 from a cookie that had simply stopped
   * working would satisfy the first half on its own. And it is the scope: the
   * seal makes every plugin controller a non-public, cookie-authenticated route
   * at one capability floor, so the two routes differ in nothing except that
   * the manifest names one of them - if the branch had been armed on the
   * plugin's mount rather than on the declared path, the summary would be 401
   * too and the plugin's own screens would have stopped working.
   */
  it("refuses the session cookie that works one route along", async () => {
    const refused = await inject({
      method: "GET",
      url: RESOURCE_PATH,
      headers: { cookie: adminCookie },
    });
    const sibling = await inject({
      method: "GET",
      url: SIBLING_PATH,
      headers: { cookie: adminCookie },
    });

    expect(refused.statusCode).toBe(401);
    // Not a handler that ran and was unwound afterwards: it never ran at all,
    // so the person it would have named is nowhere in the answer.
    expect(refused.body).not.toContain(admin.personId);
    expect(sibling.statusCode).toBe(200);
  });

  /**
   * RFC 9728's challenge, and the whole remedy a refused client is given: it
   * has an address and a 401, and without the pointer nothing it can do about
   * either. Followed rather than merely matched, because a pointer at a
   * document this instance does not serve would look identical to a correct
   * one.
   */
  it("points a refused caller at a document that names this resource", async () => {
    const refused = await inject({ method: "GET", url: RESOURCE_PATH });

    expect(refused.statusCode).toBe(401);
    const challenge = String(refused.headers["www-authenticate"]);
    const pointer = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(pointer).toBe(
      new URL(
        `/.well-known/oauth-protected-resource${RESOURCE_PATH}`,
        env.APP_URL,
      ).toString(),
    );

    const document = await inject({
      method: "GET",
      url: new URL(pointer ?? "").pathname,
    });
    expect(document.statusCode).toBe(200);
    expect(document.json()).toMatchObject({
      resource: resolvedResource().url,
    });
  });

  /**
   * Both forms of the document, and what they name.
   *
   * The bare path is what a client given only the origin will try; the sub-path
   * form is what the challenge points at. Both have to answer, and both have to
   * name the plugin's own route - the sign-in library is mounted under
   * `/api/auth`, and a resource resolved from the library's base path rather
   * than from the loaded plugins would produce an address under there that no
   * route serves and no token would ever be accepted at.
   */
  it("publishes the plugin's route as the resource, at both discovery paths", async () => {
    const bare = await inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    const beneath = await inject({
      method: "GET",
      url: `/.well-known/oauth-protected-resource${RESOURCE_PATH}`,
    });

    expect(bare.statusCode).toBe(200);
    expect(beneath.statusCode).toBe(200);
    for (const document of [bare, beneath]) {
      const named = document.json<{ resource: string }>().resource;
      expect(new URL(named).pathname).toBe(RESOURCE_PATH);
      expect(named).not.toContain("/api/auth");
    }
  });

  /**
   * A token issued for this resource, and what the route sees when one arrives.
   *
   * The client id is the half that says which branch ran: the cookie path
   * attaches a principal and no token at all, so a route reporting a connected
   * app was reached through the Bearer branch and could not have been reached
   * any other way. The person is the other half - the token acts for whoever
   * granted it, and the plugin's route runs at the capability floor its
   * permissions imply, so this is also the path that has to survive the
   * principal being rebuilt from the register on every call.
   */
  it("accepts a token issued for it and serves the person it acts for", async () => {
    const token = `plugin-resource-${suffix}`;
    await grant({ personId: admin.personId, token });

    const response = await inject({
      method: "GET",
      url: RESOURCE_PATH,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      route: "mcp",
      personId: admin.personId,
      clientId: connectedApp,
    });
  });

  /**
   * A connector serves an endpoint rather than a single route, so the paths
   * beneath the declared one have to behave the same way. Both halves in one
   * test: the sub-path really is a route this plugin serves - the token proves
   * it by getting an answer out of it and naming which handler replied - and
   * that same route refuses the browser's cookie. Separately, the first would
   * be indistinguishable from a 404.
   */
  it("covers the paths beneath it, which is where the endpoint lives", async () => {
    const token = `plugin-sub-path-${suffix}`;
    await grant({ personId: admin.personId, token });

    const refused = await inject({
      method: "GET",
      url: RESOURCE_SUB_PATH,
      headers: { cookie: adminCookie },
    });
    const accepted = await inject({
      method: "GET",
      url: RESOURCE_SUB_PATH,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(refused.statusCode).toBe(401);
    expect(refused.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      route: "mcp/messages",
      personId: admin.personId,
      clientId: connectedApp,
    });
  });

  /**
   * A token is for its own resource and for nothing else.
   *
   * The same token, in the same moment, against the route it was issued for and
   * against an ordinary one. `/api/me` is the mildest route on the instance -
   * it answers the caller their own record - and it is still 401, because the
   * cookie path is the only path it has and a bearer header is not a session.
   * Were it otherwise, a connected app granted `mcp:read` would hold a
   * credential for the whole API.
   */
  it("is not a credential on any other route", async () => {
    const token = `plugin-elsewhere-${suffix}`;
    await grant({ personId: admin.personId, token });

    const ownResource = await inject({
      method: "GET",
      url: RESOURCE_PATH,
      headers: { authorization: `Bearer ${token}` },
    });
    const ordinary = await inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(ownResource.statusCode).toBe(200);
    expect(ordinary.statusCode).toBe(401);
    expect(ordinary.body).not.toContain(admin.personId);
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

/**
 * Last, because it switches the plugin off for the rest of the process.
 *
 * A plugin's routes stay in the router once the application has been built -
 * NestJS has no way to remove one - so switching a plugin off has to bite
 * somewhere else. A board turning off a misbehaving plugin cannot be told to
 * wait for a restart.
 */
describe("switching a plugin off", () => {
  it("stops its routes, its view and its host access at once", async () => {
    await application().get(PluginAdminService).setEnabled(PLUGIN_ID, false);

    const route = await inject({
      method: "GET",
      url: `/api/plugin/${PLUGIN_ID}/summary`,
      headers: { cookie: adminCookie },
    });
    expect(route.statusCode).toBe(404);
    expect(route.json()).toMatchObject({ reason: "plugin-not-found" });

    const views = await inject({
      method: "GET",
      url: "/api/plugin-views",
      headers: { cookie: outsiderCookie },
    });
    expect(views.json()).toMatchObject({ views: [] });

    // The settings form outlives the switch: turning a plugin off is not a
    // reason to lose what it was configured with.
    const settings = await inject({
      method: "GET",
      url: `/api/plugins/${PLUGIN_ID}/settings`,
      headers: { cookie: adminCookie },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      schema: { fields: expect.any(Array) },
    });
  });
});

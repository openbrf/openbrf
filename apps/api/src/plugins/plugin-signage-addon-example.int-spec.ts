import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  formatSha512,
  PluginHostUnavailableError,
  PluginPermissionError,
  type PluginExtensionPointDeclaration,
  type PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import { dataPaths } from "../packaging/data-paths";
import { JobQueueService } from "../jobs/job-queue.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

/**
 * The sample addon to digital signage in docs/examples/signage-addon, as a
 * board gets it: built by its own toolchain against the published plugin SDK,
 * packed, listed in a catalog with its sha512, consented to, installed with
 * npm, and booted beside a host plugin that offers digital signage's `source`
 * point.
 *
 * Digital signage itself is a paid module whose source is not in this
 * repository, so the host plugin here is a stand-in: a plain CommonJS bundle
 * with signage's id, permissions, personal data, device route and the
 * `source` point, version 1, defined with the schemas
 * docs/digital-signage.md documents. Its one route does what the module does
 * on each fetch of a screen's content: lists the addons serving at the point
 * and calls each with the screen.
 *
 * What this shows is criterion 3 of digital signage's acceptance: an addon
 * written against the public SDK alone contributes a source to the rotation,
 * has a consent of its own, never holds signage's permissions, and leaves the
 * rotation when it or its host plugin is switched off.
 */

const run = promisify(execFile);
const env = loadEnvForIntegrationTests();
const suffix = runSuffix();

const ADDON = "signage-rules";
const HOST = "signage";
const HOST_PACKAGE = "openbrf-signage-stand-in";
const IDS = [ADDON, HOST];

const SIGNAGE_PERMISSIONS = [
  "news:read",
  "calendar:read",
  "bookings:readAvailability",
  "media:read",
  "addresses:read",
] as const;
/**
 * What digital signage declares: the published text and pictures its
 * permissions hand it, and the names and apartments an addon may hand it.
 */
const SIGNAGE_PERSONAL_DATA: PluginPersonalDataCategory[] = [
  "name",
  "apartment",
  "photograph",
  "freeText",
];
const SIGNAGE_PROCESSING = {
  purpose: {
    sv: "Visa föreningens innehåll på skärmar i huset.",
    en: "Show the association's content on screens in the building.",
  },
  legalBasis: "legitimateInterest",
  legitimateInterest: {
    sv: "Att nå de boende i huset.",
    en: "Reaching the residents in the building.",
  },
  retention: { sv: "Sparas inte.", en: "Not stored." },
  dataSubjects: ["members", "residents"],
} as const;
const SOURCE: PluginExtensionPointDeclaration = {
  id: "source",
  version: 1,
  personalData: ["name", "apartment"],
};

const PASSWORD = "a-long-enough-password";
const admin = {
  personId: `signage-addon-admin-${suffix}`,
  email: `signage-addon-admin-${suffix}@exempel.se`,
};
const STREET = `Tvättgatan ${suffix}`;

/** Found by walking up to the workspace file, as plugin-fixture.int-spec.ts does. */
function repositoryRoot(): string {
  const { root } = parse(process.cwd());
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      if (existsSync(join(directory, "docs", "examples"))) {
        return directory;
      }
    }
    if (directory === root) {
      return process.cwd();
    }
    directory = dirname(directory);
  }
}

const EXAMPLE = join(repositoryRoot(), "docs", "examples", "signage-addon");

/**
 * The environment the example's own toolchain runs in: the caller's, without
 * the markers a test runner hands its children, which build tools read and
 * change what they do on (see scripts/build-fixture-catalog.mjs).
 */
const buildEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("VITEST") && !name.startsWith("JEST"),
  ),
);
if (buildEnv.NODE_ENV === "test") delete buildEnv.NODE_ENV;

function inExample(command: string, args: string[]) {
  return run(command, args, {
    cwd: EXAMPLE,
    env: buildEnv,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Digital signage's entry, as the curated catalog would list it beside the
 * addon, so the addon's consent screen can name what it extends. Never
 * installed from: the stand-in is put on the volume by hand below.
 */
const SIGNAGE_ENTRY = {
  type: "plugin",
  id: HOST,
  packageName: HOST_PACKAGE,
  version: "1.0.0",
  apiVersion: 1,
  name: { sv: "Digital skyltning", en: "Digital signage" },
  description: {
    sv: "Ersätter digital skyltning i det här testet.",
    en: "Stands in for digital signage in this test.",
  },
  permissions: [...SIGNAGE_PERMISSIONS],
  personalData: SIGNAGE_PERSONAL_DATA,
  processing: SIGNAGE_PROCESSING,
  actions: [],
  deviceRoutes: [{ id: "screen", path: "screen" }],
  extensionPoints: [
    {
      id: "source",
      version: 1,
      personalData: SOURCE.personalData,
      title: { sv: "Källa", en: "Source" },
      description: {
        sv: "Bilder i en skärms visning.",
        en: "Slides in a screen's rotation.",
      },
    },
  ],
  artifact: {
    url: "file:///dev/null/signage-1.0.0.tgz",
    sha512: formatSha512(createHash("sha512").update("").digest()),
    bytes: 1,
  },
};

/**
 * The stand-in for digital signage: the `source` point with the documented
 * schemas, and a route that calls every addon serving there for one screen,
 * as the module does on each fetch of a screen's content.
 */
const HOST_BUNDLE = `const { Controller, Get, Module, Query } = require("@nestjs/common");
const { z } = require("zod");

const slide = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    heading: z.string().max(200),
    body: z.array(z.string().max(2000)).max(40),
  }),
  z.strictObject({
    kind: z.literal("table"),
    heading: z.string().max(200),
    columns: z.array(z.string().max(80)).min(1).max(4),
    rows: z.array(z.array(z.string().max(200)).max(4)).max(60),
  }),
  z.strictObject({
    kind: z.literal("doors"),
    heading: z.string().max(200),
    doors: z.array(z.strictObject({
      floor: z.int().min(-20).max(200).nullable(),
      apartment: z.string().min(1).max(20),
      names: z.array(z.string().min(1).max(80)).max(12),
    })).max(120),
  }),
]);

// The classes are made on each call, as a process that starts afresh makes
// them: Node keeps a bundle it has loaded, and this suite boots twice.
exports.createPlugin = function createPlugin(host) {
  class RotationController {
    async rotation(query) {
      const input = {
        screen: {
          id: "screen-1",
          addressId: query.addressId || null,
          placement: query.placement === "outside" ? "outside" : "inside",
          locale: query.locale === "sv" ? "sv" : "en",
        },
      };
      const answers = [];
      for (const contribution of await host.extensions.list("source")) {
        answers.push({
          ...contribution,
          result: await host.extensions.invoke("source", contribution.addon, input),
        });
      }
      return { answers };
    }
  }
  Get("rotation")(
    RotationController.prototype,
    "rotation",
    Object.getOwnPropertyDescriptor(RotationController.prototype, "rotation"),
  );
  Query()(RotationController.prototype, "rotation", 0);
  Controller()(RotationController);

  class SignageModule {}
  Module({})(SignageModule);

  host.extensions.define("source", {
    input: z.strictObject({
      screen: z.strictObject({
        id: z.string().min(1).max(64),
        addressId: z.string().min(1).max(64).nullable(),
        placement: z.enum(["inside", "outside"]),
        locale: z.enum(["sv", "en"]),
      }),
    }),
    output: z.strictObject({ slides: z.array(slide).max(8) }),
    timeoutMs: 5000,
  });
  return { module: SignageModule, controllers: [RotationController] };
};
`;

let app: NestFastifyApplication | undefined;
let prisma: PrismaService | undefined;
let workspace: string | undefined;
let addressId = "";
let adminCookie = "";
let entry: CatalogPluginEntry;
let installed: { installed: string[]; failed: unknown[] };
let testEnv: Env;
const previous = {
  dataDir: process.env.OPENBRF_DATA_DIR,
  catalogUrl: process.env.OPENBRF_CATALOG_URL,
  uncurated: process.env.OPENBRF_UNCURATED_PLUGINS_ENABLED,
};

function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

function loader(): PluginLoaderService {
  return application().get(PluginLoaderService);
}

/**
 * Starts the application on the volume, as the process does at boot. Called
 * again where the instance would replace its process: switching a plugin on
 * that is not loaded.
 */
async function boot(): Promise<void> {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
  const started = await createApplication(await loadPluginsAtBoot(testEnv));
  app = started;
  await started.init();
  await started.getHttpAdapter().getInstance().ready();
  // The instance replaces its process on its own; here, boot() does.
  vi.spyOn(
    started.get(RestartCoordinator),
    "restartWhenCommitted",
  ).mockResolvedValue(undefined as never);
}

/** A distinct forwarded address per request, in this suite's 10.84.0.0/16. */
let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  ipCounter += 1;
  const cookie = options.cookie ?? adminCookie;
  return application()
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        "x-forwarded-for": `10.84.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`,
        ...(cookie === "" ? {} : { cookie }),
      },
    });
}

interface Answer {
  addon: string;
  titleKey: string;
  descriptionKey: string | null;
  result: { ok: boolean; value?: unknown; reason?: string };
}

/** What the stand-in serves for one screen: every addon's answer. */
async function rotation(query: Record<string, string> = {}): Promise<Answer[]> {
  const response = await inject({
    method: "GET",
    url: `/api/plugin/${HOST}/rotation?${new URLSearchParams({ addressId, ...query }).toString()}`,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { answers: Answer[] }).answers;
}

beforeAll(async () => {
  const created = await mkdtemp(join(tmpdir(), "openbrf-signage-addon-"));
  workspace = created;
  const catalogDir = join(created, "catalog");
  await mkdir(catalogDir, { recursive: true });
  const signageIndex = join(created, "signage-index.json");
  await writeFile(
    signageIndex,
    JSON.stringify({ version: 2, entries: [SIGNAGE_ENTRY] }),
    "utf8",
  );

  // The example's own toolchain, from its own lockfile, as its author runs it.
  await inExample("pnpm", ["install", "--frozen-lockfile"]);
  await inExample("node", [
    "scripts/catalog.mjs",
    "--out",
    catalogDir,
    "--merge",
    signageIndex,
  ]);
  const catalogUrl = pathToFileURL(join(catalogDir, "catalog-v2.json")).href;

  testEnv = {
    ...env,
    OPENBRF_DATA_DIR: created,
    OPENBRF_PLUGINS_ENABLED: true,
    OPENBRF_CATALOG_URL: catalogUrl,
    OPENBRF_UNCURATED_PLUGINS_ENABLED: true,
  };

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    await client.installedPlugin.deleteMany({ where: { id: { in: IDS } } });
    await client.pluginDeviceRoutePath.deleteMany({
      where: { pluginId: { in: IDS } },
    });
    const registry = new PluginRegistryService(
      client as unknown as ConstructorParameters<
        typeof PluginRegistryService
      >[0],
    );
    const catalog = new CatalogClient(testEnv);
    entry = (await catalog.entry(ADDON)) as CatalogPluginEntry;

    // The addon, consented to as the catalog declares it and installed the
    // way the install job installs it: download, digest, npm.
    await registry.consent({
      id: entry.id,
      packageName: entry.packageName,
      version: entry.version,
      tarballUrl: entry.artifact.url,
      checksum: entry.artifact.sha512,
      permissions: entry.permissions,
      personalData: entry.personalData,
      actions: entry.actions,
      extensionPoints: entry.extensionPoints ?? [],
      extends: entry.extends ?? [],
      recipients: entry.recipients ?? [],
      deviceRoutes: entry.deviceRoutes ?? [],
      ai: entry.ai,
      licence: null,
    });
    const installer = new PluginInstallerService(
      testEnv,
      registry,
      new JobQueueService(testEnv),
      catalog,
      new RestartCoordinator(testEnv),
      { needsReconcile: () => false } as never,
    );
    installed = await installer.reconcile();

    // The stand-in, put on the volume beside it after npm has run.
    const directory = join(
      dataPaths(created).plugins,
      "node_modules",
      HOST_PACKAGE,
    );
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: HOST_PACKAGE,
        version: "1.0.0",
        openbrf: {
          apiVersion: 1,
          id: HOST,
          entry: { server: "./dist/server.cjs" },
          permissions: SIGNAGE_PERMISSIONS,
          personalData: SIGNAGE_PERSONAL_DATA,
          processing: SIGNAGE_PROCESSING,
          extensionPoints: [SOURCE],
          deviceRoutes: [{ id: "screen", path: "screen" }],
        },
      }),
      "utf8",
    );
    await writeFile(join(directory, "dist", "server.cjs"), HOST_BUNDLE, "utf8");
    await registry.consent({
      id: HOST,
      packageName: HOST_PACKAGE,
      version: "1.0.0",
      tarballUrl: SIGNAGE_ENTRY.artifact.url,
      checksum: SIGNAGE_ENTRY.artifact.sha512,
      permissions: [...SIGNAGE_PERMISSIONS],
      personalData: SIGNAGE_PERSONAL_DATA,
      legalBasis: SIGNAGE_PROCESSING.legalBasis,
      actions: [],
      extensionPoints: [SOURCE],
      extends: [],
      recipients: [],
      deviceRoutes: [{ id: "screen", path: "screen" }],
      ai: false,
      licence: null,
    });
  } finally {
    await client.$disconnect();
  }

  process.env.OPENBRF_DATA_DIR = created;
  process.env.OPENBRF_CATALOG_URL = catalogUrl;
  process.env.OPENBRF_UNCURATED_PLUGINS_ENABLED = "true";
  await boot();
  const started = application();

  const database = started.get(PrismaService);
  prisma = database;
  await database.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });
  addressId = (
    await database.address.create({
      data: {
        street: STREET,
        number: "3",
        postalCode: "123 45",
        city: "Exempelstad",
      },
    })
  ).id;
  await database.person.create({
    data: {
      id: admin.personId,
      firstName: "Test",
      lastName: `Skyltning${suffix}`,
      preferredLocale: "sv",
    },
  });
  await started.get(AuthService).createAccountForPerson({
    personId: admin.personId,
    email: admin.email,
    name: "Test Person",
    password: PASSWORD,
  });
  await database.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });
  const signedIn = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: admin.email, password: PASSWORD },
    cookie: "",
  });
  const setCookie = signedIn.headers["set-cookie"];
  adminCookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
    .map((value) => value.split(";")[0])
    .join("; ");
}, 420_000);

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      const client = prisma;
      await client.installedPlugin.deleteMany({ where: { id: { in: IDS } } });
      await client.pluginDeviceRoutePath.deleteMany({
        where: { pluginId: { in: IDS } },
      });
      await client.address.deleteMany({ where: { street: STREET } });
      await client.systemRole.deleteMany({
        where: { personId: admin.personId },
      });
      await client.session.deleteMany({
        where: { user: { personId: admin.personId } },
      });
      await client.account.deleteMany({
        where: { user: { personId: admin.personId } },
      });
      await client.user.deleteMany({ where: { personId: admin.personId } });
      await client.person.deleteMany({ where: { id: admin.personId } });
    }
    if (app !== undefined) {
      await app.close();
    }
  } finally {
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previous.dataDir);
    restoreEnvironmentVariable("OPENBRF_CATALOG_URL", previous.catalogUrl);
    restoreEnvironmentVariable(
      "OPENBRF_UNCURATED_PLUGINS_ENABLED",
      previous.uncurated,
    );
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

describe("the sample addon to digital signage", () => {
  it("passes its own tests, against the published SDK", async () => {
    await inExample("pnpm", ["test"]);
  });

  it("imports nothing from this repository", async () => {
    const packageJson = JSON.parse(
      await readFile(join(EXAMPLE, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };

    // The published package from the registry, not a link to the workspace.
    expect(packageJson.devDependencies["@openbrf/plugin-sdk"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    for (const range of Object.values(packageJson.devDependencies)) {
      expect(range).not.toMatch(/^(file|link|workspace|portal):/);
    }
  });

  it("installs from the catalog with npm and loads", () => {
    expect(installed.failed).toEqual([]);
    expect(installed.installed).toEqual([ADDON]);
    expect(loader().get(ADDON)).not.toBeNull();
    expect(loader().get(HOST)).not.toBeNull();
    expect(
      loader()
        .report()
        .filter((finding) => IDS.includes(finding.id ?? "")),
    ).toEqual([]);
  });
});

describe("its consent", () => {
  it("is its own: its permission, no personal data, and what it extends", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugins/catalog",
    });
    expect(response.statusCode).toBe(200);
    const view = (
      response.json() as {
        entries: {
          id: string;
          permissions: string[];
          personalData: string[];
          processing: unknown;
          extends: unknown[];
        }[];
      }
    ).entries.find((candidate) => candidate.id === ADDON);

    expect(view).toMatchObject({
      permissions: ["addresses:read"],
      personalData: [],
      processing: null,
      extends: [
        {
          plugin: HOST,
          point: "source",
          version: 1,
          pluginName: { sv: "Digital skyltning", en: "Digital signage" },
          pointTitle: { sv: "Källa", en: "Source" },
        },
      ],
    });
  });

  it("is what the board consented to, apart from digital signage's", async () => {
    const registry = application().get(PluginRegistryService);

    expect(await registry.find(ADDON)).toMatchObject({
      consentedPermissions: ["addresses:read"],
      declaredPersonalData: [],
    });
    expect((await registry.find(HOST))?.consentedPermissions).toEqual([
      ...SIGNAGE_PERMISSIONS,
    ]);
  });
});

describe("in a screen's rotation", () => {
  it("contributes its slides, under its own title and description", async () => {
    const answers = await rotation();

    expect(answers).toEqual([
      {
        addon: ADDON,
        titleKey: `plugin-${ADDON}:source.title`,
        descriptionKey: `plugin-${ADDON}:source.description`,
        result: {
          ok: true,
          value: {
            slides: [
              {
                kind: "text",
                heading: `Laundry room, ${STREET} 3`,
                body: expect.arrayContaining([
                  "Empty the lint filter of the tumble dryer.",
                ]) as unknown,
              },
              {
                kind: "table",
                heading: "Opening hours",
                columns: ["Days", "Time"],
                rows: [
                  ["Monday to Friday", "07:00–22:00"],
                  ["Saturday and Sunday", "09:00–20:00"],
                ],
              },
            ],
          },
        },
      },
    ]);
  });

  it("answers in the screen's language, and gives a screen outside the building nothing", async () => {
    const [swedish] = await rotation({ locale: "sv" });
    expect(swedish?.result.value).toMatchObject({
      slides: [
        { heading: `Tvättstugan, ${STREET} 3` },
        { heading: "Öppettider" },
      ],
    });

    const [outside] = await rotation({ placement: "outside" });
    expect(outside?.result).toEqual({ ok: true, value: { slides: [] } });
  });

  it("hands the board its title and description from its own locale files", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/i18n/en/plugin-${ADDON}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      "source.title": "Laundry room rules",
      "source.description": expect.stringContaining(
        "everyone who passes the screen",
      ) as unknown,
    });
  });
});

describe("digital signage's permissions", () => {
  it("are never the addon's: it reads addresses under its own, and is refused the news", async () => {
    const addon = loader().get(ADDON)?.host;
    const signage = loader().get(HOST)?.host;

    expect(addon?.permissions).toEqual(["addresses:read"]);
    expect(signage?.permissions).toEqual([...SIGNAGE_PERMISSIONS]);

    await expect(addon?.news.published({ limit: 1 })).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
    await expect(signage?.news.published({ limit: 1 })).resolves.toBeInstanceOf(
      Array,
    );
  });
});

describe("switching it off", () => {
  it("takes the addon out of the rotation when the board switches it off", async () => {
    const disabled = await inject({
      method: "PUT",
      url: `/api/plugins/${ADDON}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    expect(await rotation()).toEqual([]);
    expect(loader().get(ADDON)).toBeNull();
  });

  it("puts it back in the rotation when the board switches it on again", async () => {
    const enabled = await inject({
      method: "PUT",
      url: `/api/plugins/${ADDON}/enabled`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ restarting: true });
    await boot();

    expect((await rotation()).map((answer) => answer.addon)).toEqual([ADDON]);
  });

  it("stops the addon when digital signage is switched off", async () => {
    const addonHost = loader().get(ADDON)?.host;
    expect(addonHost).toBeDefined();

    const disabled = await inject({
      method: "PUT",
      url: `/api/plugins/${HOST}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    // The screen's content route answers as a plugin switched off does, the
    // addon's host object refuses, and the board is told why it waits.
    const served = await inject({
      method: "GET",
      url: `/api/plugin/${HOST}/rotation`,
    });
    expect(served.statusCode).toBe(404);
    expect(loader().get(ADDON)).toBeNull();
    await expect(addonHost?.addresses.list()).rejects.toBeInstanceOf(
      PluginHostUnavailableError,
    );
    expect(
      loader()
        .report()
        .find((finding) => finding.id === ADDON),
    ).toMatchObject({
      reason: "extension-host-missing",
      detail: { plugin: HOST },
    });
  });
});

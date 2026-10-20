import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  type PluginExtensionDeclaration,
  type PluginExtensionPointDeclaration,
  type PluginHost,
  PluginHostUnavailableError,
  type PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { dataPaths } from "../packaging/data-paths";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Plugins that extend plugins (ADR 0030), from the packages on the volume to
 * a host plugin's own route, against a real database and the real boot.
 *
 * Every package here is written by hand as plain CommonJS against the public
 * contract alone - the host object it is handed, `@nestjs/common` and the
 * host's `zod` - which is all a third-party addon has. The host plugin offers
 * one extension point, `source`, and a route that lists the contributions
 * serving there and calls each. Around it:
 *
 *   residents  an addon with no permissions of its own, which tries to send
 *              mail through its own host object while it answers - the host
 *              plugin holds `mail:send`, and the addon must not.
 *   weather    an addon that hands over no personal data.
 *   leaky      an addon that answers with a field the point does not name.
 *   outdated   written for version 2 of a point at version 1.
 *   orphan     extends a plugin that is not installed.
 *   greedy     hands over email, which the point does not accept.
 *   widened    hands over names, where the board consented to nothing.
 *
 * The last four are refused before their code runs, and each one's bundle
 * marks a global if it ever does.
 */

const env = loadEnvForIntegrationTests();

const suffix = runSuffix();
const HOST = `ext-host-${suffix}`;
const RESIDENTS = `ext-residents-${suffix}`;
const WEATHER = `ext-weather-${suffix}`;
const LEAKY = `ext-leaky-${suffix}`;
const OUTDATED = `ext-outdated-${suffix}`;
const ORPHAN = `ext-orphan-${suffix}`;
const GREEDY = `ext-greedy-${suffix}`;
const WIDENED = `ext-widened-${suffix}`;
const ALL_IDS = [
  HOST,
  RESIDENTS,
  WEATHER,
  LEAKY,
  OUTDATED,
  ORPHAN,
  GREEDY,
  WIDENED,
];
const REFUSED_IDS = [OUTDATED, ORPHAN, GREEDY, WIDENED];

/** Where a bundle marks that its code ran, and where an addon leaves its host. */
const ran = (id: string): string => `__openbrfRan_${id.replaceAll("-", "_")}`;
const RESIDENTS_HOST = `__openbrfHost_${RESIDENTS.replaceAll("-", "_")}`;

const PASSWORD = "a-long-enough-password";
const admin = {
  personId: `ext-admin-${suffix}`,
  email: `ext-admin-${suffix}@exempel.se`,
};

const SOURCE: PluginExtensionPointDeclaration = {
  id: "source",
  version: 1,
  personalData: ["name"],
};

function extending(
  overrides: Partial<PluginExtensionDeclaration> = {},
): PluginExtensionDeclaration {
  return {
    plugin: HOST,
    point: "source",
    version: 1,
    personalData: [],
    ...overrides,
  };
}

/** The host plugin: one point, and a route that calls every addon there. */
const HOST_BUNDLE = `const { Controller, Get, Module, Param } = require("@nestjs/common");
const { z } = require("zod");

let host;

class SourcesController {
  async sources() {
    const listed = await host.extensions.list("source");
    const answers = [];
    for (const contribution of listed) {
      answers.push({
        ...contribution,
        result: await host.extensions.invoke("source", contribution.addon, {
          screen: "entrance-a",
        }),
      });
    }
    return { answers };
  }

  async call(addon) {
    return host.extensions.invoke("source", addon, { screen: "entrance-a" });
  }
}
Get()(
  SourcesController.prototype,
  "sources",
  Object.getOwnPropertyDescriptor(SourcesController.prototype, "sources"),
);
Get(":addon")(
  SourcesController.prototype,
  "call",
  Object.getOwnPropertyDescriptor(SourcesController.prototype, "call"),
);
Param("addon")(SourcesController.prototype, "call", 0);
Controller("sources")(SourcesController);

class HostModule {}
Module({})(HostModule);

exports.createPlugin = function createPlugin(given) {
  host = given;
  host.extensions.define("source", {
    input: z.strictObject({ screen: z.string() }),
    output: z.strictObject({
      items: z.array(z.strictObject({ text: z.string() })),
    }),
  });
  return { module: HostModule, controllers: [SourcesController] };
};
`;

/** An addon whose handler answers with what `answer` returns. */
function addonBundle(id: string, answer: string): string {
  return `const { Controller, Get, Module } = require("@nestjs/common");

globalThis[${JSON.stringify(ran(id))}] = true;
let host;

class PingController {
  ping() {
    return { ok: true };
  }
}
Get()(
  PingController.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(PingController.prototype, "ping"),
);
Controller("ping")(PingController);

class AddonModule {}
Module({})(AddonModule);

exports.createPlugin = function createPlugin(given) {
  host = given;
  globalThis[${JSON.stringify(`__openbrfHost_${id.replaceAll("-", "_")}`)}] = given;
  host.extensions.contribute(
    { plugin: ${JSON.stringify(HOST)}, point: "source" },
    {
      titleKey: "source.title",
      handler: async (input, context) => {
        ${answer}
      },
    },
  );
  return { module: AddonModule, controllers: [PingController] };
};
`;
}

const RESIDENTS_ANSWER = `let mail = "sent";
        try {
          await host.mail.send({
            to: "styrelsen@exempel.se",
            subject: "Från tillägget",
            text: "Hej",
          });
        } catch (error) {
          mail = error.name;
        }
        return {
          items: [
            { text: [input.screen, context.hostPlugin, context.point, String(context.version), mail].join(" ") },
          ],
        };`;

interface Package {
  id: string;
  permissions: string[];
  personalData: PluginPersonalDataCategory[];
  extensionPoints?: PluginExtensionPointDeclaration[];
  extends?: PluginExtensionDeclaration[];
  /** What the board consented to, where it is not what the manifest says. */
  consentedExtends?: PluginExtensionDeclaration[];
  bundle: string;
}

const PACKAGES: Package[] = [
  {
    id: HOST,
    permissions: ["mail:send"],
    personalData: ["name"],
    extensionPoints: [SOURCE],
    bundle: HOST_BUNDLE,
  },
  {
    id: RESIDENTS,
    permissions: [],
    personalData: ["name"],
    extends: [extending({ personalData: ["name"] })],
    bundle: addonBundle(RESIDENTS, RESIDENTS_ANSWER),
  },
  {
    id: WEATHER,
    permissions: [],
    personalData: [],
    extends: [extending()],
    bundle: addonBundle(WEATHER, `return { items: [{ text: "Sol" }] };`),
  },
  {
    id: LEAKY,
    permissions: [],
    personalData: ["name", "email"],
    extends: [extending({ personalData: ["name"] })],
    bundle: addonBundle(
      LEAKY,
      `return { items: [{ text: "Anna", email: "anna@exempel.se" }] };`,
    ),
  },
  {
    id: OUTDATED,
    permissions: [],
    personalData: [],
    extends: [extending({ version: 2 })],
    bundle: addonBundle(OUTDATED, `return { items: [] };`),
  },
  {
    id: ORPHAN,
    permissions: [],
    personalData: [],
    extends: [extending({ plugin: `ext-missing-${suffix}` })],
    bundle: addonBundle(ORPHAN, `return { items: [] };`),
  },
  {
    id: GREEDY,
    permissions: [],
    personalData: ["name", "email"],
    extends: [extending({ personalData: ["name", "email"] })],
    bundle: addonBundle(GREEDY, `return { items: [] };`),
  },
  {
    id: WIDENED,
    permissions: [],
    personalData: ["name"],
    extends: [extending({ personalData: ["name"] })],
    consentedExtends: [extending()],
    bundle: addonBundle(WIDENED, `return { items: [] };`),
  },
];

let app: NestFastifyApplication | undefined;
let prisma: PrismaService | undefined;
let workspace: string | undefined;
let previousDataDir: string | undefined;
let adminCookie = "";

function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

/** A distinct forwarded address per request, in this suite's 10.83.0.0/16. */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  return `10.83.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
}) {
  return application()
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        ...(adminCookie === "" ? {} : { cookie: adminCookie }),
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

interface Answer {
  addon: string;
  titleKey: string;
  result: { ok: boolean; value?: unknown; reason?: string };
}

/** What the host plugin's own route gets back from every addon serving. */
async function sources(): Promise<Answer[]> {
  const response = await inject({
    method: "GET",
    url: `/api/plugin/${HOST}/sources`,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { answers: Answer[] }).answers;
}

function loader(): PluginLoaderService {
  return application().get(PluginLoaderService);
}

beforeAll(async () => {
  const created = await mkdtemp(join(tmpdir(), "openbrf-plugin-extensions-"));
  workspace = created;

  for (const plugin of PACKAGES) {
    const directory = join(
      dataPaths(created).plugins,
      "node_modules",
      `openbrf-plugin-${plugin.id}`,
    );
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: `openbrf-plugin-${plugin.id}`,
        version: "1.0.0",
        openbrf: {
          apiVersion: 1,
          id: plugin.id,
          entry: { server: "./dist/server.cjs" },
          permissions: plugin.permissions,
          personalData: plugin.personalData,
          extensionPoints: plugin.extensionPoints ?? [],
          extends: plugin.extends ?? [],
        },
      }),
      "utf8",
    );
    await writeFile(
      join(directory, "dist", "server.cjs"),
      plugin.bundle,
      "utf8",
    );
  }

  const consenting = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const registry = new PluginRegistryService(
      consenting as unknown as ConstructorParameters<
        typeof PluginRegistryService
      >[0],
    );
    for (const plugin of PACKAGES) {
      await registry.consent({
        id: plugin.id,
        packageName: `openbrf-plugin-${plugin.id}`,
        version: "1.0.0",
        tarballUrl: `file:///dev/null/${plugin.id}.tgz`,
        checksum: "sha512-unused-in-this-suite",
        permissions: plugin.permissions as never,
        personalData: plugin.personalData,
        actions: [],
        extensionPoints: plugin.extensionPoints ?? [],
        extends: plugin.consentedExtends ?? plugin.extends ?? [],
      });
    }
  } finally {
    await consenting.$disconnect();
  }

  previousDataDir = process.env.OPENBRF_DATA_DIR;
  process.env.OPENBRF_DATA_DIR = created;
  const started = await createApplication(
    await loadPluginsAtBoot({
      ...env,
      OPENBRF_DATA_DIR: created,
      OPENBRF_PLUGINS_ENABLED: true,
    } satisfies Env),
  );
  app = started;
  await started.init();
  await started.getHttpAdapter().getInstance().ready();

  // Removing a plugin ends by asking the installer to take the package off the
  // volume and replace the process; what removal does to the running addons
  // happens before that, and is what is asserted here.
  vi.spyOn(started.get(PluginInstallerService), "enqueue").mockResolvedValue(
    undefined as never,
  );

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
  await database.person.create({
    data: {
      id: admin.personId,
      firstName: "Test",
      lastName: `Utökning${suffix}`,
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
  adminCookie = await signIn(admin.email);
}, 180_000);

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      const client = prisma;
      await client.installedPlugin.deleteMany({
        where: { id: { in: ALL_IDS } },
      });
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
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
    for (const id of ALL_IDS) {
      Reflect.deleteProperty(globalThis, ran(id));
    }
    Reflect.deleteProperty(globalThis, RESIDENTS_HOST);
  }
});

describe("an addon written against the public contract", () => {
  it("contributes to the host plugin's point, and the host plugin calls it", async () => {
    const answers = await sources();

    expect(answers.map((answer) => answer.addon)).toEqual([
      LEAKY,
      RESIDENTS,
      WEATHER,
    ]);
    expect(answers.find((answer) => answer.addon === WEATHER)).toEqual({
      addon: WEATHER,
      titleKey: `plugin-${WEATHER}:source.title`,
      descriptionKey: null,
      result: { ok: true, value: { items: [{ text: "Sol" }] } },
    });
  });

  it("is told which point it answers", async () => {
    const answers = await sources();
    const residents = answers.find((answer) => answer.addon === RESIDENTS);

    expect(residents?.result.ok).toBe(true);
    expect(JSON.stringify(residents?.result.value)).toContain(
      `entrance-a ${HOST} source 1`,
    );
  });

  it("never receives the host plugin's permissions", async () => {
    // The host plugin may send mail. The addon, answering the host plugin's
    // call, tried to through its own host object and was refused.
    const answers = await sources();
    const residents = answers.find((answer) => answer.addon === RESIDENTS);

    expect(residents?.result.value).toEqual({
      items: [{ text: `entrance-a ${HOST} source 1 PluginPermissionError` }],
    });
    const addonHost = Reflect.get(globalThis, RESIDENTS_HOST) as PluginHost;
    expect(addonHost.permissions).toEqual([]);
    expect(loader().get(HOST)?.host.permissions).toEqual(["mail:send"]);
  });

  it("hands over nothing the point's schema does not name", async () => {
    const answers = await sources();

    expect(answers.find((answer) => answer.addon === LEAKY)?.result).toEqual({
      ok: false,
      reason: "output-invalid",
    });
  });
});

describe("an addon that cannot serve at its point", () => {
  it("is refused before its code runs, and the board is told why", () => {
    const findings = loader()
      .report()
      .filter((finding) => REFUSED_IDS.includes(finding.id ?? ""));

    expect(
      findings.map(({ id, reason, detail }) => ({ id, reason, detail })),
    ).toEqual(
      expect.arrayContaining([
        {
          id: OUTDATED,
          reason: "extension-version-unsupported",
          detail: { plugin: HOST, point: "source", version: 2, supported: 1 },
        },
        {
          id: ORPHAN,
          reason: "extension-host-missing",
          detail: { plugin: `ext-missing-${suffix}` },
        },
        {
          id: GREEDY,
          reason: "extension-personal-data-refused",
          detail: { plugin: HOST, point: "source", categories: ["email"] },
        },
        {
          id: WIDENED,
          reason: "extensions-widened",
          detail: { extensions: [`${HOST}/source`] },
        },
      ]),
    );
    for (const id of REFUSED_IDS) {
      expect(loader().get(id)).toBeNull();
      expect(Reflect.get(globalThis, ran(id))).toBeUndefined();
    }
  });
});

describe("switching plugins off and removing them", () => {
  it("takes an addon switched off out of the host plugin's point", async () => {
    const disabled = await inject({
      method: "PUT",
      url: `/api/plugins/${WEATHER}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    expect((await sources()).map((answer) => answer.addon)).not.toContain(
      WEATHER,
    );
    const called = await inject({
      method: "GET",
      url: `/api/plugin/${HOST}/sources/${WEATHER}`,
    });
    expect(called.json()).toEqual({ ok: false, reason: "not-serving" });
  });

  it("stops every addon of a host plugin that is switched off", async () => {
    const disabled = await inject({
      method: "PUT",
      url: `/api/plugins/${HOST}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    // The addon's routes answer as though it were not installed, and its host
    // object refuses, as when the board switches the addon off itself.
    const pinged = await inject({
      method: "GET",
      url: `/api/plugin/${RESIDENTS}/ping`,
    });
    expect(pinged.statusCode).toBe(404);
    const addonHost = Reflect.get(globalThis, RESIDENTS_HOST) as PluginHost;
    await expect(addonHost.settings.read()).rejects.toBeInstanceOf(
      PluginHostUnavailableError,
    );
    expect(
      loader()
        .report()
        .find((finding) => finding.id === RESIDENTS),
    ).toMatchObject({
      reason: "extension-host-missing",
      detail: { plugin: HOST },
    });
  });

  it("leaves the addons installed when the host plugin is removed", async () => {
    const removed = await inject({
      method: "DELETE",
      url: `/api/plugins/${HOST}`,
    });
    expect(removed.statusCode).toBe(200);

    // Putting the host plugin back does not mean consenting to each addon
    // again.
    const residents = await application()
      .get(PluginRegistryService)
      .find(RESIDENTS);
    expect(residents).toMatchObject({
      enabled: true,
      consentedExtends: [`${HOST}:source:1:name`],
    });
    expect(loader().get(RESIDENTS)).toBeNull();
  });
});

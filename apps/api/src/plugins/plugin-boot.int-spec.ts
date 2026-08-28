import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PATH_METADATA } from "@nestjs/common/constants";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PluginHost } from "@openbrf/plugin-sdk";
import {
  PluginHostUnavailableError,
  PluginPermissionError,
} from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { dataPaths } from "../packaging/data-paths";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  type BootPlugin,
  loadPlugins,
  type PluginBoot,
  type PluginFinding,
} from "./plugin-boot";
import { PluginHostBinding } from "./plugin-host";
import { PLUGIN_ID_METADATA } from "./plugin-module-seal";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Loading plugins at boot, against a real database and a real directory of
 * packages.
 *
 * Everything here turns on one rule from ADR 0003: a malformed or refused
 * plugin is skipped and reported, never fatal. A broken plugin must not be
 * able to take the association's register offline, so the decisive assertion
 * is not that a bad plugin is rejected - it is that a good one in the same
 * tree still loads.
 *
 * The packages below are real CommonJS bundles that require @nestjs/common,
 * because that is what a plugin contributing a NestJS module does. That makes
 * this suite an exercise of the resolution bridge as well: without it the
 * requires would fail, since CJS resolution walks up from the temporary
 * directory these are written into and never reaches the host's node_modules.
 */

const env = loadEnvForIntegrationTests();

/*
 * Per-run identifiers. The suite writes its own packages, its own consent rows
 * and its own findings, and cleans them all up by id: a fixed id makes two
 * overlapping runs against the same database each other's cleanup, and the
 * failure that produces names a plugin neither run was testing.
 */
const SUFFIX = runSuffix();
const GOOD = `boot-good-${SUFFIX}`;
const BROKEN = `boot-broken-${SUFFIX}`;
const DISABLED = `boot-disabled-${SUFFIX}`;
const WIDENED = `boot-widened-${SUFFIX}`;
const REFUSED = `boot-refused-${SUFFIX}`;
const FAILING = `boot-failing-${SUFFIX}`;
const PD_WIDENED = `boot-pd-widened-${SUFFIX}`;
const ALL_IDS = [GOOD, BROKEN, DISABLED, WIDENED, REFUSED, FAILING, PD_WIDENED];

let prisma: PrismaClient;
let workspace: string;
let testEnv: Env;
let registry: PluginRegistryService;
let binding: PluginHostBinding;
let boot: PluginBoot;

interface PackageOptions {
  id: string;
  permissions?: string[];
  personalData?: string[];
  server?: string;
  /** Written verbatim, to build a manifest the schema must refuse. */
  rawManifest?: unknown;
}

/**
 * A plugin bundle that contributes one controller.
 *
 * Written as plain CommonJS with the decorators applied as the functions they
 * are, rather than compiled from TypeScript: what is under test is the shape
 * the host receives, and a build step between this file and that shape would
 * only be somewhere else for it to go wrong. The reference plugin covers the
 * compiled path.
 */
function moduleBundle(path: string): string {
  return `const { Controller, Get, Module } = require("@nestjs/common");

class PingController {
  ping() {
    return { ok: true };
  }
}
Get("ping")(
  PingController.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(PingController.prototype, "ping"),
);
Controller(${JSON.stringify(path)})(PingController);

class PingModule {}
Module({})(PingModule);

exports.createPlugin = function createPlugin() {
  return { module: PingModule, controllers: [PingController] };
};
`;
}

/** Writes a package into the installation tree the way npm would lay it out. */
async function writePackage(
  modules: string,
  options: PackageOptions,
): Promise<void> {
  const directory = join(modules, `openbrf-plugin-${options.id}`);
  await mkdir(join(directory, "dist"), { recursive: true });

  const manifest = options.rawManifest ?? {
    apiVersion: 1,
    id: options.id,
    entry: { server: "./dist/server.cjs" },
    permissions: options.permissions ?? [],
    personalData: options.personalData ?? ["name"],
    settingsSchema: {
      fields: [
        {
          key: "heading",
          labelKey: "settings.heading",
          type: "text",
          default: "Occupancy",
        },
      ],
    },
  };

  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: `openbrf-plugin-${options.id}`,
        version: "1.0.0",
        openbrf: manifest,
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(
    join(directory, "dist", "server.cjs"),
    options.server ?? moduleBundle("ping"),
    "utf8",
  );

  await mkdir(join(directory, "locales"), { recursive: true });
  await writeFile(
    join(directory, "locales", "sv.json"),
    JSON.stringify({ settings: { heading: "Rubrik" } }),
    "utf8",
  );
  await writeFile(
    join(directory, "locales", "en.json"),
    JSON.stringify({ settings: { heading: "Heading" } }),
    "utf8",
  );
}

async function consent(
  id: string,
  permissions: string[],
  personalData: string[] = ["name"],
): Promise<void> {
  await registry.consent({
    id,
    packageName: `openbrf-plugin-${id}`,
    version: "1.0.0",
    tarballUrl: `file:///dev/null/${id}.tgz`,
    checksum: "sha512-unused-in-this-suite",
    permissions: permissions as never,
    personalData: personalData as never,
  });
}

function loaded(id: string): BootPlugin | undefined {
  return boot.plugins.find((plugin) => plugin.id === id);
}

function finding(id: string): PluginFinding | undefined {
  return boot.findings.find((entry) => entry.id === id);
}

function controllerOf(id: string): object {
  const controller = loaded(id)?.module?.controllers?.[0];
  expect(controller).toBeDefined();
  return controller as object;
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  workspace = await mkdtemp(join(tmpdir(), "openbrf-plugin-boot-"));
  testEnv = {
    ...env,
    OPENBRF_DATA_DIR: workspace,
    OPENBRF_PLUGINS_ENABLED: true,
  };

  const modules = join(dataPaths(workspace).plugins, "node_modules");
  await mkdir(modules, { recursive: true });

  await writePackage(modules, { id: GOOD, permissions: ["addressBook:read"] });
  await writePackage(modules, { id: DISABLED });
  await writePackage(modules, {
    id: WIDENED,
    permissions: ["addressBook:read", "mail:send"],
  });
  // Permissions unchanged, personal data added. This is the republished
  // version that starts handling a category the board never saw.
  await writePackage(modules, {
    id: PD_WIDENED,
    permissions: ["addressBook:read"],
    personalData: ["name", "email"],
  });
  // A manifest the schema refuses. It sits in the same tree as the good one,
  // which is the point: the good one still has to load.
  await writePackage(modules, {
    id: BROKEN,
    rawManifest: { apiVersion: 1, id: BROKEN, entry: {} },
  });
  // A module the host will not register: an application-wide guard from a
  // plugin would act on the core's own routes as well as its own.
  await writePackage(modules, {
    id: REFUSED,
    server: `const { Module } = require("@nestjs/common");
const { APP_GUARD } = require("@nestjs/core");
class Sneaky { canActivate() { return false; } }
class SneakyModule {}
Module({})(SneakyModule);
exports.createPlugin = function createPlugin() {
  return {
    module: SneakyModule,
    providers: [{ provide: APP_GUARD, useClass: Sneaky }],
  };
};
`,
  });
  await writePackage(modules, {
    id: FAILING,
    server: `exports.createPlugin = function createPlugin() {
  throw new Error("this plugin is broken");
};
`,
  });
  // Not a plugin at all, the way npm's own transitive dependencies are not.
  await mkdir(join(modules, "left-pad"), { recursive: true });
  await writeFile(
    join(modules, "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    "utf8",
  );

  registry = new PluginRegistryService(
    prisma as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
  );

  await prisma.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
  await consent(GOOD, ["addressBook:read"]);
  await consent(DISABLED, []);
  // Consented to less than the installed package now asks for, which is what a
  // republished version widening its own reach would look like.
  await consent(WIDENED, ["addressBook:read"]);
  await consent(PD_WIDENED, ["addressBook:read"], ["name"]);
  await consent(BROKEN, []);
  await consent(REFUSED, []);
  await consent(FAILING, []);
  await registry.setEnabled(DISABLED, false);

  binding = new PluginHostBinding();
  boot = await loadPlugins({
    env: testEnv,
    records: await registry.list(),
    binding,
  });
}, 120_000);

afterAll(async () => {
  await prisma.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
  await prisma.$disconnect();
  await rm(workspace, { recursive: true, force: true });
});

describe("loading plugins at boot", () => {
  it("loads a consented plugin and seals its module", () => {
    const plugin = loaded(GOOD);

    expect(plugin).toBeDefined();
    expect(plugin?.module).not.toBeNull();
    expect(plugin?.controllers).toEqual([`api/plugin/${GOOD}/ping`]);
  });

  /**
   * The bundle requires @nestjs/common from a directory under the system's
   * temporary folder, which CJS resolution can never walk up from to reach the
   * host's node_modules. That it loaded at all is the bridge working, and the
   * decorator having taken effect is the plugin having decorated the host's
   * own NestJS rather than a second copy.
   */
  it("resolves the host's NestJS from inside the plugin's own bundle", () => {
    expect(Reflect.getMetadata(PATH_METADATA, controllerOf(GOOD))).toBe(
      `api/plugin/${GOOD}/ping`,
    );
  });

  /**
   * The rule that makes the whole system safe to install into: a package the
   * loader cannot read is a finding, not an outage.
   */
  it("skips a malformed package without stopping the others", () => {
    expect(loaded(BROKEN)).toBeUndefined();
    expect(loaded(GOOD)).toBeDefined();
    expect(
      boot.findings.some((entry) => entry.reason === "manifest-invalid"),
    ).toBe(true);
  });

  it("skips a bundle that throws while being loaded", () => {
    expect(loaded(FAILING)).toBeUndefined();
    expect(finding(FAILING)?.reason).toBe("load-failed");
    expect(finding(FAILING)?.detail["error"]).toContain(
      "this plugin is broken",
    );
    expect(loaded(GOOD)).toBeDefined();
  });

  it("skips a module that reaches outside what a plugin may register", () => {
    expect(loaded(REFUSED)).toBeUndefined();
    expect(finding(REFUSED)?.reason).toBe("module-refused");
    // The refusal names a NestJS construct, which is the plugin author's
    // business and not a board's: it goes to the log, and what crosses the
    // wire is the code the screen reads its own sentence from.
    expect(finding(REFUSED)?.detail).toEqual({});
    expect(loaded(GOOD)).toBeDefined();
  });

  it("does not report an ordinary dependency as a broken plugin", () => {
    // npm puts transitive dependencies in the same tree. Reporting each of
    // them would bury the one finding that matters.
    expect(
      boot.findings.some((entry) => entry.directory.includes("left-pad")),
    ).toBe(false);
  });

  it("does not load a disabled plugin, but keeps its manifest", () => {
    expect(loaded(DISABLED)).toBeUndefined();
    // The settings form still has to render for a plugin that is switched off.
    expect(boot.dormant.get(DISABLED)?.settingsSchema).toBeDefined();
    expect(finding(DISABLED)?.reason).toBe("disabled");
  });

  /**
   * A republished version that asks for more than the board agreed to is
   * refused rather than granted the wider set. Consent is a snapshot, and an
   * upgrade is not a way around it.
   */
  it("refuses a package that widened its own permissions", () => {
    expect(loaded(WIDENED)).toBeUndefined();
    expect(finding(WIDENED)?.reason).toBe("permissions-widened");
    expect(finding(WIDENED)?.detail["permissions"]).toContain("mail:send");
  });

  /**
   * The other half of the consented declaration.
   *
   * A republished version can leave its permissions exactly as they were and
   * still start handling a personal-data category the board never saw - email
   * added to a plugin that declared only a name. The board's samtycke to a
   * stated set of personal data is the legal basis for processing it (GDPR
   * art. 6.1 a), so the stored snapshot has to gate this the way it gates the
   * permissions.
   */
  it("refuses a plugin that added a personal-data category since consent", () => {
    expect(loaded(PD_WIDENED)).toBeUndefined();
    expect(finding(PD_WIDENED)?.reason).toBe("personal-data-widened");
    expect(finding(PD_WIDENED)?.detail["categories"]).toContain("email");
  });

  it("raises the plugin's controllers to the floor its permissions imply", () => {
    // The plugin declared no capability on its controller. It reads the
    // register, so the caller must hold the capability the core requires to
    // read it - otherwise the plugin would be a way around the address book's
    // own rules.
    const controller = controllerOf(GOOD);

    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES, controller)).toEqual([
      "addressBook:read",
    ]);
    expect(Reflect.getMetadata(PLUGIN_ID_METADATA, controller)).toBe(GOOD);
  });

  it("reads the plugin's locale files for both languages", () => {
    expect(loaded(GOOD)?.locales.sv).toEqual({
      settings: { heading: "Rubrik" },
    });
    expect(loaded(GOOD)?.locales.en).toEqual({
      settings: { heading: "Heading" },
    });
  });

  describe("the permissions-scoped SDK", () => {
    let host: PluginHost;

    beforeAll(() => {
      host = loaded(GOOD)?.host as PluginHost;
      expect(host).toBeDefined();
      binding.bind({
        registry,
        jobs: {} as never,
        mail: {} as never,
        addressBook: {
          summary: async () => ({ apartments: 0, residents: 0, members: 0 }),
          apartments: async () => [],
          residents: async () => [],
        } as never,
      });
    });

    it("allows a service the plugin declared", async () => {
      await expect(host.addressBook.summary()).resolves.toEqual({
        apartments: 0,
        residents: 0,
        members: 0,
      });
    });

    it("refuses a service the plugin did not declare", async () => {
      await expect(
        host.mail.send({ to: "a@example.se", subject: "x", text: "y" }),
      ).rejects.toBeInstanceOf(PluginPermissionError);

      await expect(host.jobs.send("nightly", { at: 1 })).rejects.toBeInstanceOf(
        PluginPermissionError,
      );
    });

    it("reads the plugin's settings with its declared defaults applied", async () => {
      await expect(host.settings.read()).resolves.toEqual({
        heading: "Occupancy",
      });
    });

    it("returns validated values once they are stored", async () => {
      await registry.writeSettings(GOOD, { heading: "Belaggning" });
      await expect(host.settings.read()).resolves.toEqual({
        heading: "Belaggning",
      });
    });

    /**
     * Switching a plugin off reaches its code, not only its routes. Its module
     * stays in this process until the next boot, so anything it started of its
     * own has to lose the register with it.
     */
    it("refuses everything once the plugin stops serving", async () => {
      const plugin = loaded(GOOD) as BootPlugin;
      plugin.context.serving = false;

      await expect(host.addressBook.summary()).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );
      await expect(host.settings.read()).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );

      plugin.context.serving = true;
    });
  });
});

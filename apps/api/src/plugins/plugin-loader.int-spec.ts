import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import type { PluginHost, PluginRoute } from "@openbrf/plugin-sdk";
import { PluginPermissionError } from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { I18nService } from "../i18n/i18n.service";
import { dataPaths } from "../packaging/data-paths";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { PluginHostFactory } from "./plugin-host.factory";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * The loader, against a real database and a real directory of packages.
 *
 * Everything here turns on one rule from ADR 0003: a malformed or refused
 * plugin is skipped and reported, never fatal. A broken plugin must not be
 * able to take the association's register offline, so the decisive assertion
 * is not that a bad plugin is rejected - it is that a good one in the same
 * tree still loads.
 */

const env = loadEnvForIntegrationTests();

const GOOD = "loader-good";
const BROKEN = "loader-broken";
const DISABLED = "loader-disabled";
const WIDENED = "loader-widened";
const ALL_IDS = [GOOD, BROKEN, DISABLED, WIDENED];

let prisma: PrismaClient;
let workspace: string;
let testEnv: Env;
let registry: PluginRegistryService;
let loader: PluginLoaderService;
let i18n: I18nService;

interface PackageOptions {
  id: string;
  permissions?: string[];
  server?: string;
  locales?: boolean;
  /** Written verbatim, to build a manifest the schema must refuse. */
  rawManifest?: unknown;
}

/**
 * Writes a package into the installation tree the way npm would lay it out.
 *
 * The bundles require nothing: a prebuilt CommonJS bundle whose only externals
 * are host packages is the contract, and a fixture that pulled in a dependency
 * would not be exercising it.
 */
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
    personalData: ["name"],
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
    options.server ??
      `exports.createPlugin = function createPlugin(host) {
  return {
    routes: [
      { method: "GET", path: "/ping", handle: function handle() { return { id: host.id }; } },
    ],
  };
};
`,
    "utf8",
  );

  if (options.locales !== false) {
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
}

async function consent(id: string, permissions: string[]): Promise<void> {
  await registry.consent({
    id,
    packageName: `openbrf-plugin-${id}`,
    version: "1.0.0",
    tarballUrl: `file:///dev/null/${id}.tgz`,
    checksum: "sha512-unused-in-this-suite",
    permissions: permissions as never,
    personalData: ["name"],
  });
}

/**
 * The half of the SDK this suite does not exercise.
 *
 * Passed as stand-ins so the permission gate can be tested without a mail
 * server or a populated register: the gate runs before any of them is
 * reached, which is the property under test.
 */
const stubs = {
  jobs: {} as never,
  mail: {} as never,
  addressBook: {
    summary: async () => ({ apartments: 0, residents: 0, members: 0 }),
    apartments: async () => [],
    residents: async () => [],
  } as never,
};

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  workspace = await mkdtemp(join(tmpdir(), "openbrf-plugin-loader-"));
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
  // A manifest the schema refuses. It sits in the same tree as the good one,
  // which is the point: the good one still has to load.
  await writePackage(modules, {
    id: BROKEN,
    rawManifest: { apiVersion: 1, id: BROKEN, entry: {} },
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
  await consent(BROKEN, []);
  await registry.setEnabled(DISABLED, false);

  i18n = new I18nService();
  await i18n.init();

  loader = new PluginLoaderService(
    testEnv,
    registry,
    new PluginHostFactory(registry, stubs.jobs, stubs.mail, stubs.addressBook),
    i18n,
  );

  await loader.onModuleInit();
}, 120_000);

afterAll(async () => {
  await prisma.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
  await prisma.$disconnect();
  await rm(workspace, { recursive: true, force: true });
});

describe("PluginLoaderService", () => {
  it("loads a consented plugin and registers its routes", () => {
    const plugin = loader.get(GOOD);

    expect(plugin).not.toBeNull();
    expect([...(plugin?.routes.keys() ?? [])]).toEqual(["GET /ping"]);
  });

  /**
   * The rule that makes the whole system safe to install into: a package the
   * loader cannot read is a finding, not an outage.
   */
  it("skips a malformed package without stopping the others", () => {
    expect(loader.get(BROKEN)).toBeNull();
    expect(loader.get(GOOD)).not.toBeNull();
    expect(
      loader.report().some((finding) => finding.reason === "manifest-invalid"),
    ).toBe(true);
  });

  it("does not report an ordinary dependency as a broken plugin", () => {
    // npm puts transitive dependencies in the same tree. Reporting each of
    // them would bury the one finding that matters.
    expect(
      loader.report().some((finding) => finding.directory.includes("left-pad")),
    ).toBe(false);
  });

  it("does not load a disabled plugin, but keeps its manifest", () => {
    expect(loader.get(DISABLED)).toBeNull();
    // The settings form still has to render for a plugin that is switched off.
    expect(loader.manifestFor(DISABLED)?.settingsSchema).toBeDefined();
    expect(
      loader.report().some((finding) => finding.reason === "disabled"),
    ).toBe(true);
  });

  /**
   * A republished version that asks for more than the board agreed to is
   * refused rather than granted the wider set. Consent is a snapshot, and an
   * upgrade is not a way around it.
   */
  it("refuses a package that widened its own permissions", () => {
    expect(loader.get(WIDENED)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === WIDENED);
    expect(finding?.reason).toBe("permissions-widened");
    expect(finding?.detail).toContain("mail:send");
  });

  it("merges the plugin's locale files under its own namespace", () => {
    const translate = i18n.translatorFor("sv");
    expect(translate(`plugin-${GOOD}:settings.heading`)).toBe("Rubrik");
    expect(i18n.translatorFor("en")(`plugin-${GOOD}:settings.heading`)).toBe(
      "Heading",
    );
  });

  it("serves the same bundle to the lazy namespace endpoint", () => {
    expect(loader.get(GOOD)?.locales.sv).toEqual({
      settings: { heading: "Rubrik" },
    });
  });

  it("raises a route's capability to the floor its permissions imply", () => {
    // The plugin declared no capability on its route. It reads the register,
    // so the caller must hold the capability the core requires to read it -
    // otherwise the plugin would be a way around the address book's own rules.
    const entry = loader.get(GOOD)?.routes.get("GET /ping");
    expect(entry?.capability).toBe("addressBook:read");
  });

  describe("the permissions-scoped SDK", () => {
    let host: PluginHost;

    beforeAll(() => {
      const plugin = loader.get(GOOD);
      expect(plugin).not.toBeNull();
      host = plugin?.host as PluginHost;
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
  });

  describe("unloading", () => {
    it("stops serving a plugin at once", () => {
      const route: PluginRoute | undefined = loader
        .get(GOOD)
        ?.routes.get("GET /ping")?.route;
      expect(route).toBeDefined();

      loader.unload(GOOD);

      // Disabling has to bite without a restart: a board switching off a
      // misbehaving plugin cannot be told to wait for one.
      expect(loader.get(GOOD)).toBeNull();
      expect(loader.manifestFor(GOOD)).not.toBeNull();
    });
  });
});

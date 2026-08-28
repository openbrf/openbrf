import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { I18nService } from "../i18n/i18n.service";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import { dataPaths } from "../packaging/data-paths";
import { JobQueueService } from "../jobs/job-queue.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { scanPluginDirectory } from "./plugin-directory";
import { PluginHostFactory } from "./plugin-host.factory";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

/**
 * The reference plugin, installed from the fixture catalog.
 *
 * This is the whole contract in one pass and against the real artefacts: a
 * package built by its own toolchain against the published SDK's types, packed
 * into a tarball, listed in a catalog with its sha512, downloaded, verified,
 * installed with npm, loaded, and asked to serve a request through the scoped
 * SDK - with its Swedish and English strings merged under its own namespace
 * along the way.
 *
 * The catalog is a local file and the tarball is built in this repository, so
 * the same verification code runs with no network. That is the harness the
 * end-to-end suite reuses, with the tarballs baked into the test image instead
 * of built here.
 */

const run = promisify(execFile);
const env = loadEnvForIntegrationTests();

/**
 * The repository root.
 *
 * Found by walking up to the workspace file rather than counting directories
 * from this one, because the API is CommonJS in production and ESM under the
 * test runner and neither __dirname nor import.meta.dirname exists in both.
 */
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

let prisma: PrismaClient;
let workspace: string;
let testEnv: Env;
let registry: PluginRegistryService;
let installer: PluginInstallerService;
let loader: PluginLoaderService;
let i18n: I18nService;
let entry: CatalogPluginEntry;

/**
 * Builds the fixture when it is not already there.
 *
 * The catalog and the tarball are build output rather than committed files -
 * the digest changes whenever the fixture's source does, and a committed
 * digest would be wrong the first time somebody edited it. Building on demand
 * keeps this suite runnable from a clean clone.
 */
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

beforeAll(async () => {
  await ensureFixture();

  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  workspace = await mkdtemp(join(tmpdir(), "openbrf-plugin-fixture-"));
  testEnv = {
    ...env,
    OPENBRF_DATA_DIR: workspace,
    OPENBRF_PLUGINS_ENABLED: true,
    OPENBRF_CATALOG_URL: pathToFileURL(CATALOG).href,
    // The fixture index is not the curated one, which is exactly what this
    // flag gates.
    OPENBRF_UNCURATED_PLUGINS_ENABLED: true,
  };

  registry = new PluginRegistryService(
    prisma as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
  );

  const catalog = new CatalogClient(testEnv);
  const found = await catalog.entry(PLUGIN_ID);
  expect(found?.type).toBe("plugin");
  entry = found as CatalogPluginEntry;

  installer = new PluginInstallerService(
    testEnv,
    registry,
    new JobQueueService(testEnv),
    catalog,
    new RestartCoordinator(testEnv),
    { needsReconcile: () => false } as never,
  );

  i18n = new I18nService();
  await i18n.init();

  loader = new PluginLoaderService(
    testEnv,
    registry,
    new PluginHostFactory(
      registry,
      {} as never,
      {} as never,
      {
        summary: async () => ({ apartments: 42, residents: 68, members: 51 }),
        apartments: async () =>
          Array.from({ length: 40 }, (_, index) => ({
            id: `apartment-${String(index)}`,
            number: String(1001 + index),
            floor: 1,
            address: { id: "address-1", street: "Storgatan", number: "12" },
          })),
        residents: async () => [],
      } as never,
    ),
    i18n,
  );

  await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
}, 420_000);

afterAll(async () => {
  await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
  await prisma.$disconnect();
  await rm(workspace, { recursive: true, force: true });
});

describe("the reference plugin", () => {
  it("installs from the fixture catalog and loads", async () => {
    await registry.consent({
      id: entry.id,
      packageName: entry.packageName,
      version: entry.version,
      tarballUrl: entry.artifact.url,
      checksum: entry.artifact.sha512,
      permissions: entry.permissions,
      personalData: entry.personalData,
    });

    const outcome = await installer.reconcile();
    expect(outcome.failed).toEqual([]);
    expect(outcome.installed).toEqual([PLUGIN_ID]);

    const scan = await scanPluginDirectory(dataPaths(workspace).plugins);
    const discovered = scan.plugins.find((plugin) => plugin.id === PLUGIN_ID);

    expect(discovered).toBeDefined();
    // Both halves of the contract are present: the CommonJS server bundle the
    // host requires, and the Module Federation remote entry the browser loads.
    expect(discovered?.serverEntry).toMatch(/dist\/server\.cjs$/);
    expect(discovered?.clientEntry).toMatch(/dist\/remoteEntry\.js$/);

    await loader.onModuleInit();

    const loaded = loader.get(PLUGIN_ID);
    expect(loaded).not.toBeNull();
    expect([...(loaded?.routes.keys() ?? [])].sort()).toEqual([
      "GET /apartments",
      "GET /summary",
    ]);
  }, 420_000);

  it("serves its route through the scoped address-book service", async () => {
    const route = loader.get(PLUGIN_ID)?.routes.get("GET /summary");
    expect(route).toBeDefined();

    const answer = (await route?.route.handle({
      query: {},
      body: null,
      personId: "person-1",
    })) as { heading: string; summary: { apartments: number } };

    expect(answer.summary.apartments).toBe(42);
    // The manifest's declared default, applied by the host rather than guessed
    // by the plugin.
    expect(answer.heading).toBe("Occupancy");
  });

  it("applies the settings the board stored", async () => {
    await registry.writeSettings(PLUGIN_ID, {
      heading: "Belaggning",
      rowLimit: 3,
      showMembers: false,
      grouping: "floor",
    });

    const route = loader.get(PLUGIN_ID)?.routes.get("GET /apartments");
    const answer = (await route?.route.handle({
      query: {},
      body: null,
      personId: "person-1",
    })) as { apartments: unknown[] };

    // The plugin read a value written after it was loaded, which is what the
    // settings service reading on every call is for.
    expect(answer.apartments).toHaveLength(3);
  });

  it("merges its Swedish and English strings under its own namespace", () => {
    expect(i18n.translatorFor("sv")(`plugin-${PLUGIN_ID}:view.title`)).not.toBe(
      "view.title",
    );
    expect(i18n.translatorFor("en")(`plugin-${PLUGIN_ID}:view.title`)).not.toBe(
      "view.title",
    );
    // Different languages, so the merge is per locale and not one bundle
    // serving both.
    expect(i18n.translatorFor("sv")(`plugin-${PLUGIN_ID}:view.title`)).not.toBe(
      i18n.translatorFor("en")(`plugin-${PLUGIN_ID}:view.title`),
    );
  });

  it("declares a settings schema the host can render", () => {
    const schema = loader.manifestFor(PLUGIN_ID)?.settingsSchema;
    expect(schema?.fields.map((field) => field.type).sort()).toEqual([
      "boolean",
      "number",
      "select",
      "text",
    ]);
  });
});

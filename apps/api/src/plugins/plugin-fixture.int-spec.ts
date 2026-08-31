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
import { type BootPlugin, loadPlugins, type PluginBoot } from "./plugin-boot";
import { scanPluginDirectory } from "./plugin-directory";
import { PluginHostBinding } from "./plugin-host";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

/**
 * The reference plugin, installed from the fixture catalog.
 *
 * This is the whole contract in one pass and against the real artefacts: a
 * package built by its own toolchain against the published SDK's types, packed
 * into a tarball, listed in a catalog with its sha512, downloaded, verified,
 * installed with npm, and loaded - contributing a NestJS module whose
 * controllers the host seals onto its own prefix, with its Swedish and English
 * strings merged under its own namespace along the way. What those controllers
 * then answer over HTTP is plugin-http.int-spec.ts.
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

let prisma: PrismaClient | undefined;
let workspace: string | undefined;
let testEnv: Env;
let registry: PluginRegistryService;
let installer: PluginInstallerService;
let binding: PluginHostBinding;
let boot: PluginBoot;
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

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  prisma = client;

  const created = await mkdtemp(join(tmpdir(), "openbrf-plugin-fixture-"));
  workspace = created;
  testEnv = {
    ...env,
    OPENBRF_DATA_DIR: created,
    OPENBRF_PLUGINS_ENABLED: true,
    OPENBRF_CATALOG_URL: pathToFileURL(CATALOG).href,
    // The fixture index is not the curated one, which is exactly what this
    // flag gates.
    OPENBRF_UNCURATED_PLUGINS_ENABLED: true,
  };

  registry = new PluginRegistryService(
    client as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
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

  binding = new PluginHostBinding();
  binding.bind({
    registry,
    jobs: {} as never,
    mail: {} as never,
    sms: {} as never,
    addressBook: {
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
  });

  await client.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
}, 420_000);

function loaded(): BootPlugin | undefined {
  return boot.plugins.find((plugin) => plugin.id === PLUGIN_ID);
}

afterAll(async () => {
  /*
   * beforeAll builds the fixture, a database client and a workspace in that
   * order and can fail at any of them, so the client may not exist - which is
   * the only thing guarded here. A deletion that fails is not: the integration
   * suites share one database, and swallowing the failure would leave an
   * installed-plugin row behind for whatever runs next and still report a
   * green run, and neither is a removal that fails: a temporary directory
   * left behind is left behind. The disconnect and the removal are in
   * `finally` either way, so nothing is held open by a failure being allowed
   * through.
   */
  try {
    if (prisma !== undefined) {
      const client = prisma;
      try {
        await client.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
      } finally {
        await client.$disconnect();
      }
    }
  } finally {
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
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

    const scan = await scanPluginDirectory(
      dataPaths(testEnv.OPENBRF_DATA_DIR).plugins,
    );
    const discovered = scan.plugins.find((plugin) => plugin.id === PLUGIN_ID);

    expect(discovered).toBeDefined();
    // Both halves of the contract are present: the CommonJS server bundle the
    // host requires, and the Module Federation remote entry the browser loads.
    expect(discovered?.serverEntry).toMatch(/dist\/server\.cjs$/);
    expect(discovered?.clientEntry).toMatch(/dist\/remoteEntry\.js$/);

    boot = await loadPlugins({
      env: testEnv,
      records: await registry.list(),
      binding,
    });

    expect(boot.findings).toEqual([]);
    expect(loaded()).toBeDefined();
  }, 420_000);

  /**
   * The bundle is compiled TypeScript that requires @nestjs/common from
   * /data/plugins, where CJS resolution can never reach the application's own
   * node_modules. That its decorators produced a module the host could seal is
   * the resolution bridge and the identity assertion both working against a
   * real installed package rather than a hand-written fixture.
   */
  it("contributes a NestJS module the host mounts under its own prefix", () => {
    expect(loaded()?.module).not.toBeNull();
    expect(loaded()?.controllers).toEqual([`api/plugin/${PLUGIN_ID}`]);
    expect(loaded()?.module?.providers).toHaveLength(2);
  });

  it("merges its Swedish and English strings under its own namespace", () => {
    i18n.addPluginResources(PLUGIN_ID, loaded()?.locales ?? {});
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
    const schema = loaded()?.manifest.settingsSchema;
    expect(schema?.fields.map((field) => field.type).sort()).toEqual([
      "boolean",
      "number",
      "select",
      "text",
    ]);
  });

  /**
   * The permissions the board consented to, taken from the database rather
   * than from the manifest the package shipped with.
   */
  it("receives a host scoped to what was consented to", async () => {
    const host = loaded()?.host;

    expect(host?.permissions).toEqual(["addressBook:read"]);
    await expect(host?.addressBook.summary()).resolves.toMatchObject({
      apartments: 42,
    });
    await expect(
      host?.mail.send({ to: "a@exempel.se", subject: "x", text: "y" }),
    ).rejects.toThrow();
  });
});

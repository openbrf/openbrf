import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { CatalogClient } from "../packaging/catalog.client";
import { dataPaths } from "../packaging/data-paths";
import { formatSha512, sha512 } from "../packaging/integrity";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { scanPluginDirectory } from "./plugin-directory";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

/**
 * The install contract, end to end against a real database and a real npm.
 *
 * The whole point of these assertions is the property the plan calls for and
 * that no unit test can show: the flow converges. It is run twice from the
 * same state, run again after the tree is deleted underneath it, and run after
 * a plugin is withdrawn - and each time the volume ends up matching the
 * database rather than accumulating the difference.
 *
 * The catalog is a local file and the tarball is built here, so the same
 * verification code runs with no network at all. That is exactly the harness
 * the end-to-end suite reuses with tarballs baked into the test image.
 */

const run = promisify(execFile);
const env = loadEnvForIntegrationTests();

const PLUGIN_ID = "occupancy-int";
const PACKAGE_NAME = "openbrf-plugin-occupancy-int";
const VERSION = "1.0.0";

let prisma: PrismaClient;
let workspace: string;
let dataDir: string;
let catalogPath: string;
let registry: PluginRegistryService;
let installer: PluginInstallerService;
let testEnv: Env;

/**
 * A plugin package, built here rather than checked in.
 *
 * The bundle requires nothing: ADR 0003 makes a prebuilt CommonJS bundle whose
 * only externals are host packages the contract, and a fixture that quietly
 * depended on something from a registry would not be testing that contract.
 */
async function buildPluginTarball(directory: string): Promise<{
  tarball: string;
  sha512: string;
}> {
  const source = join(directory, "package");
  await mkdir(join(source, "dist"), { recursive: true });
  await mkdir(join(source, "locales"), { recursive: true });

  await writeFile(
    join(source, "package.json"),
    JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: VERSION,
        private: false,
        main: "dist/server.cjs",
        files: ["dist", "locales"],
        openbrf: {
          apiVersion: 1,
          id: PLUGIN_ID,
          entry: { server: "./dist/server.cjs" },
          permissions: ["addressBook:read"],
          personalData: ["name", "apartment"],
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
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(
    join(source, "dist", "server.cjs"),
    `const { Controller, Get, Module } = require("@nestjs/common");

class SummaryController {
  summary() {
    return { ok: true };
  }
}
Get("summary")(
  SummaryController.prototype,
  "summary",
  Object.getOwnPropertyDescriptor(SummaryController.prototype, "summary"),
);
Controller()(SummaryController);

class SummaryModule {}
Module({})(SummaryModule);

exports.createPlugin = function createPlugin() {
  return { module: SummaryModule, controllers: [SummaryController] };
};
`,
    "utf8",
  );

  await writeFile(
    join(source, "locales", "sv.json"),
    JSON.stringify({ settings: { heading: "Rubrik" } }),
    "utf8",
  );
  await writeFile(
    join(source, "locales", "en.json"),
    JSON.stringify({ settings: { heading: "Heading" } }),
    "utf8",
  );

  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const { stdout } = await run(
    "npm",
    ["pack", "--json", "--pack-destination", artifacts],
    { cwd: source },
  );
  const packed = JSON.parse(stdout) as { filename: string }[];
  const tarball = join(artifacts, packed[0]?.filename ?? "");

  return {
    tarball,
    sha512: formatSha512(sha512(await readFile(tarball))),
  };
}

async function writeCatalog(
  path: string,
  tarball: string,
  digest: string,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: PLUGIN_ID,
          type: "plugin",
          packageName: PACKAGE_NAME,
          version: VERSION,
          apiVersion: 1,
          name: { sv: "Belaggning", en: "Occupancy" },
          description: { sv: "Testtillagg", en: "Test plugin" },
          permissions: ["addressBook:read"],
          personalData: ["name", "apartment"],
          artifact: {
            url: pathToFileURL(tarball).href,
            sha512: digest,
          },
        },
      ],
    }),
    "utf8",
  );
}

/** Installs the plugin's consent row, as the admin screen or the CLI would. */
async function consent(digest: string, tarball: string): Promise<void> {
  await registry.consent({
    id: PLUGIN_ID,
    packageName: PACKAGE_NAME,
    version: VERSION,
    tarballUrl: pathToFileURL(tarball).href,
    checksum: digest,
    permissions: ["addressBook:read"],
    personalData: ["name", "apartment"],
  });
}

let tarball: string;
let digest: string;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  workspace = await mkdtemp(join(tmpdir(), "openbrf-plugin-install-"));
  dataDir = join(workspace, "data");
  catalogPath = join(workspace, "catalog.json");

  const built = await buildPluginTarball(workspace);
  tarball = built.tarball;
  digest = built.sha512;
  await writeCatalog(catalogPath, tarball, digest);

  testEnv = {
    ...env,
    OPENBRF_DATA_DIR: dataDir,
    OPENBRF_PLUGINS_ENABLED: true,
    OPENBRF_CATALOG_URL: pathToFileURL(catalogPath).href,
    // The fixture index is not the curated one, and pointing an instance
    // anywhere else is exactly what this flag gates.
    OPENBRF_UNCURATED_PLUGINS_ENABLED: true,
  };

  registry = new PluginRegistryService(
    prisma as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
  );
  installer = new PluginInstallerService(
    testEnv,
    registry,
    new JobQueueService(testEnv),
    new CatalogClient(testEnv),
    new RestartCoordinator(testEnv),
    // The reconcile never touches the loader; passing a stand-in keeps the
    // suite from booting plugin code it is not testing here.
    { needsReconcile: () => false } as never,
  );

  await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
}, 120_000);

afterAll(async () => {
  await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
  await prisma.$disconnect();
  await rm(workspace, { recursive: true, force: true });
});

describe("the plugin install flow", () => {
  it("verifies, installs and records the plugin", async () => {
    await consent(digest, tarball);

    const outcome = await installer.reconcile();

    expect(outcome.failed).toEqual([]);
    expect(outcome.installed).toContain(PLUGIN_ID);
    expect(outcome.changed).toBe(true);

    const scan = await scanPluginDirectory(dataPaths(dataDir).plugins);
    expect(scan.plugins.map((plugin) => plugin.id)).toContain(PLUGIN_ID);
    expect(scan.skipped).toEqual([]);

    const record = await registry.find(PLUGIN_ID);
    expect(record?.status).toBe("INSTALLED");
    expect(record?.lastError).toBeNull();
  }, 180_000);

  /**
   * The property the whole design exists for. A second run from the same
   * desired state must be a no-op, because the install job is retried by
   * pg-boss and re-run on every boot that finds the volume out of step - and a
   * run that rebuilt the tree each time would restart the container in a loop.
   */
  it("is a no-op when the volume already matches", async () => {
    const outcome = await installer.reconcile();

    expect(outcome.changed).toBe(false);
    expect(outcome.failed).toEqual([]);
    expect(outcome.installed).toContain(PLUGIN_ID);
  }, 120_000);

  /**
   * The volume-less deployment, and equally a crash after the database was
   * written and before the files were moved: the desired state is intact, so
   * the next run rebuilds from it without the catalog being consulted again.
   */
  it("reinstalls when the installation tree has gone missing", async () => {
    await rm(join(dataPaths(dataDir).plugins, "node_modules"), {
      recursive: true,
      force: true,
    });
    await rm(join(dataPaths(dataDir).plugins, "package.json"), {
      force: true,
    });

    const outcome = await installer.reconcile();

    expect(outcome.changed).toBe(true);
    const scan = await scanPluginDirectory(dataPaths(dataDir).plugins);
    expect(scan.plugins.map((plugin) => plugin.id)).toContain(PLUGIN_ID);
  }, 180_000);

  /**
   * Removal is a deleted row. The volume follows, which is what makes an
   * uninstall recoverable from a crash rather than a sequence of filesystem
   * operations that could half-happen.
   */
  it("removes the package when its row is gone", async () => {
    await registry.remove(PLUGIN_ID);

    const outcome = await installer.reconcile();

    expect(outcome.installed).toEqual([]);
    const scan = await scanPluginDirectory(dataPaths(dataDir).plugins);
    expect(scan.plugins.map((plugin) => plugin.id)).not.toContain(PLUGIN_ID);
  }, 180_000);

  /**
   * The digest is the whole of the trust model for the bytes that arrive. A
   * mismatch must leave the row failed and the volume untouched, never
   * unpacked and hoped for.
   */
  it("refuses an archive whose digest does not match the catalog", async () => {
    await registry.consent({
      id: PLUGIN_ID,
      packageName: PACKAGE_NAME,
      version: VERSION,
      tarballUrl: pathToFileURL(tarball).href,
      checksum: formatSha512(sha512(Buffer.from("not this archive"))),
      permissions: ["addressBook:read"],
      personalData: ["name", "apartment"],
    });

    const outcome = await installer.reconcile();

    expect(outcome.installed).toEqual([]);
    expect(outcome.failed.map((failure) => failure.id)).toContain(PLUGIN_ID);

    const record = await registry.find(PLUGIN_ID);
    expect(record?.status).toBe("FAILED");
    expect(record?.lastError).toContain("Digest mismatch");

    const scan = await scanPluginDirectory(dataPaths(dataDir).plugins);
    expect(scan.plugins.map((plugin) => plugin.id)).not.toContain(PLUGIN_ID);
  }, 120_000);
});

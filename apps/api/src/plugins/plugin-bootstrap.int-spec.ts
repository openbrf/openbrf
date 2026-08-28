import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { dataPaths } from "../packaging/data-paths";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
} from "../testing/integration-env";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * The boot sequence, with a plugin the application cannot be built around.
 *
 * A plugin now contributes a NestJS module, and a module whose providers do
 * not resolve fails the whole container - which would make a broken plugin
 * fatal to boot, the one thing ADR 0003 says it must never be. The bootstrap
 * answers that by dropping the plugin NestJS names in the error and building
 * again, so the association's register comes up either way.
 *
 * The decisive assertion is not that the bad plugin was dropped. It is that
 * the good one in the same tree is serving afterwards, and that the
 * application answered a request at all.
 */

const env = loadEnvForIntegrationTests();

const GOOD = "bootstrap-good";
const UNBUILDABLE = "bootstrap-unbuildable";
const ALL_IDS = [GOOD, UNBUILDABLE];

/** A module the injector cannot construct: a provider with a missing dependency. */
const UNBUILDABLE_BUNDLE = `const { Controller, Get, Injectable, Module } = require("@nestjs/common");

class Absent {}

class NeedsAbsent {}
Injectable()(NeedsAbsent);
Reflect.defineMetadata("design:paramtypes", [Absent], NeedsAbsent);

class UnbuildableController {
  go() {
    return {};
  }
}
Reflect.defineMetadata("design:paramtypes", [NeedsAbsent], UnbuildableController);
Get()(
  UnbuildableController.prototype,
  "go",
  Object.getOwnPropertyDescriptor(UnbuildableController.prototype, "go"),
);
Controller("go")(UnbuildableController);

class UnbuildableModule {}
Module({})(UnbuildableModule);

exports.createPlugin = function createPlugin() {
  return {
    module: UnbuildableModule,
    controllers: [UnbuildableController],
    providers: [NeedsAbsent],
  };
};
`;

const WORKING_BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

class WorkingController {
  ping() {
    return { ok: true };
  }
}
Get("ping")(
  WorkingController.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(WorkingController.prototype, "ping"),
);
Controller()(WorkingController);

class WorkingModule {}
Module({})(WorkingModule);

exports.createPlugin = function createPlugin() {
  return { module: WorkingModule, controllers: [WorkingController] };
};
`;

let prisma: PrismaClient;
let registry: PluginRegistryService;
let app: NestFastifyApplication;
let workspace: string;
let previousDataDir: string | undefined;

async function writePackage(
  modules: string,
  id: string,
  bundle: string,
): Promise<void> {
  const directory = join(modules, `openbrf-plugin-${id}`);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: `openbrf-plugin-${id}`,
      version: "1.0.0",
      openbrf: {
        apiVersion: 1,
        id,
        entry: { server: "./dist/server.cjs" },
        permissions: [],
        personalData: [],
      },
    }),
    "utf8",
  );
  await writeFile(join(directory, "dist", "server.cjs"), bundle, "utf8");
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  registry = new PluginRegistryService(
    prisma as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
  );

  workspace = await mkdtemp(join(tmpdir(), "openbrf-plugin-bootstrap-"));
  const modules = join(dataPaths(workspace).plugins, "node_modules");
  await mkdir(modules, { recursive: true });
  await writePackage(modules, GOOD, WORKING_BUNDLE);
  await writePackage(modules, UNBUILDABLE, UNBUILDABLE_BUNDLE);

  await prisma.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
  for (const id of ALL_IDS) {
    await registry.consent({
      id,
      packageName: `openbrf-plugin-${id}`,
      version: "1.0.0",
      tarballUrl: `file:///dev/null/${id}.tgz`,
      checksum: "sha512-unused-in-this-suite",
      permissions: [],
      personalData: [],
    });
  }

  // Set on the environment as well as passed in: the application's own
  // configuration module reads process.env when the container is built.
  previousDataDir = process.env.OPENBRF_DATA_DIR;
  process.env.OPENBRF_DATA_DIR = workspace;
  const testEnv: Env = {
    ...env,
    OPENBRF_DATA_DIR: workspace,
    OPENBRF_PLUGINS_ENABLED: true,
  };

  app = await createApplication(await loadPluginsAtBoot(testEnv));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  /*
   * Every step is guarded, because beforeAll can fail before any of these
   * exist. An unconditional dereference here would throw a TypeError that
   * replaces the setup failure in the report and skips the cleanup that was
   * still possible - and the environment restore, which the next suite in this
   * worker depends on, is the part that must happen either way.
   */
  try {
    await app.close();
  } catch {
    // The application never started.
  }

  try {
    await prisma.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
    await prisma.$disconnect();
  } catch {
    // No client, or the database is already gone.
  } finally {
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
    await rm(workspace, { recursive: true, force: true }).catch(() => {
      // The workspace was never created.
    });
  }
});

describe("booting with a plugin the application cannot be built around", () => {
  it("starts anyway", async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });

  it("keeps serving the plugin that does build", async () => {
    expect(app.get(PluginLoaderService).get(GOOD)).not.toBeNull();

    // 401 rather than 404: the route is in the router and the application's
    // own guard answered it, which is the whole of what registering the
    // plugin's controller was supposed to achieve.
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${GOOD}/ping` });

    expect(response.statusCode).toBe(401);
  });

  it("reports the one it dropped rather than failing", () => {
    const loader = app.get(PluginLoaderService);

    expect(loader.get(UNBUILDABLE)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === UNBUILDABLE);
    expect(finding?.reason).toBe("module-failed");
    // Its manifest survives, so the admin screen can still show what it is.
    expect(loader.manifestFor(UNBUILDABLE)).not.toBeNull();
  });

  it("does not serve the dropped plugin's routes", async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${UNBUILDABLE}/go` });

    expect(response.statusCode).toBe(404);
  });
});

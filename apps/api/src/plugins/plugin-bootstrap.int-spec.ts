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

let prisma: PrismaClient | undefined;
let registry: PluginRegistryService;
let app: NestFastifyApplication | undefined;
let workspace: string | undefined;
let previousDataDir: string | undefined;

/**
 * The running application.
 *
 * Asked for through here rather than assumed present, so the teardown can tell
 * "never started" from "would not close" - the one being a setup failure
 * already in the report, the other an application a passing run would
 * otherwise leave listening.
 */
function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

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
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  prisma = client;
  registry = new PluginRegistryService(
    client as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
  );

  const created = await mkdtemp(join(tmpdir(), "openbrf-plugin-bootstrap-"));
  workspace = created;
  const modules = join(dataPaths(created).plugins, "node_modules");
  await mkdir(modules, { recursive: true });
  await writePackage(modules, GOOD, WORKING_BUNDLE);
  await writePackage(modules, UNBUILDABLE, UNBUILDABLE_BUNDLE);

  await client.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
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
  process.env.OPENBRF_DATA_DIR = created;
  const testEnv: Env = {
    ...env,
    OPENBRF_DATA_DIR: created,
    OPENBRF_PLUGINS_ENABLED: true,
  };

  const started = await createApplication(await loadPluginsAtBoot(testEnv));
  app = started;
  await started.init();
  await started.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  /*
   * beforeAll can fail before any of these exist, so each is asked for before
   * it is used. Nothing beyond that is guarded: a close, a deletion or a
   * removal that fails is a real failure of this run, and the integration
   * files share one database and one temporary directory, so a listening
   * application, an installed-plugin row or a workspace left behind is there
   * for whatever runs next. A catch here would report that as a green run.
   *
   * The environment restore, which the next suite in this worker depends on,
   * is in `finally` so it happens whatever the rest did.
   */
  try {
    if (app !== undefined) {
      await app.close();
    }
    if (prisma !== undefined) {
      const client = prisma;
      try {
        await client.installedPlugin.deleteMany({
          where: { id: { in: ALL_IDS } },
        });
      } finally {
        await client.$disconnect();
      }
    }
  } finally {
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

describe("booting with a plugin the application cannot be built around", () => {
  it("starts anyway", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });

  it("keeps serving the plugin that does build", async () => {
    expect(application().get(PluginLoaderService).get(GOOD)).not.toBeNull();

    // 401 rather than 404: the route is in the router and the application's
    // own guard answered it, which is the whole of what registering the
    // plugin's controller was supposed to achieve.
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${GOOD}/ping` });

    expect(response.statusCode).toBe(401);
  });

  it("reports the one it dropped rather than failing", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(UNBUILDABLE)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === UNBUILDABLE);
    expect(finding?.reason).toBe("module-failed");
    // Its manifest survives, so the admin screen can still show what it is.
    expect(loader.manifestFor(UNBUILDABLE)).not.toBeNull();
  });

  /**
   * NestJS composes that failure from the names in the plugin's own bundle,
   * which the package chose and which can hold anything at all. The code
   * crosses the wire and the message goes to the server log, the same way
   * every other refusal on this screen is reported.
   */
  it("does not publish what the failure said", () => {
    const report = application().get(PluginLoaderService).report();
    const finding = report.find((entry) => entry.id === UNBUILDABLE);

    expect(finding?.detail).toEqual({});
    expect(JSON.stringify(report)).not.toContain("NeedsAbsent");
  });

  it("does not serve the dropped plugin's routes", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${UNBUILDABLE}/go` });

    expect(response.statusCode).toBe(404);
  });
});

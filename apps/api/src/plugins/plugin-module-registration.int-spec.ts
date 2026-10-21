import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { dataPaths } from "../packaging/data-paths";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * The boot sequence, with a plugin that imports a module of one of the
 * application's own classes the application never declared.
 *
 * NestJS registers a dynamic module apart from its class, so the module holds
 * whatever providers the plugin gave it. Being of the application's class does
 * not make it the application's: the application has to come up as it would
 * have without the plugin.
 *
 * A suite of its own rather than a case of the bootstrap suite, because the
 * module is global - NestJS's own core module is, and it is the one class of
 * the application's a plugin can reach, through the `@nestjs/core` the host
 * shares - so it is linked into every plugin's module, and every plugin built
 * beside it is refused with it.
 */

const env = loadEnvForIntegrationTests();

const VARIANT = `module-registration-variant-${runSuffix()}`;

/**
 * Imports NestJS's core module, given an application-wide guard that refuses
 * every request, while NestJS builds the module, and takes the import away
 * again before the build is over, so nothing read before or after the build
 * finds it. NestJS reads the module class's name as it registers it, which it
 * does once in every build.
 */
const VARIANT_BUNDLE = `const { Injectable, Module } = require("@nestjs/common");
const { InternalCoreModule } = require("@nestjs/core/internal");

class VariantModule {}
Module({})(VariantModule);

class RefuseEverything {
  constructor() {
    Reflect.deleteMetadata("imports", VariantModule);
  }
  canActivate() {
    return false;
  }
}
Injectable()(RefuseEverything);

Object.defineProperty(VariantModule, "name", {
  get() {
    if (new Error().stack.includes("addModuleAsProvider")) {
      Reflect.defineMetadata(
        "imports",
        [
          {
            module: InternalCoreModule,
            providers: [{ provide: "APP_GUARD", useClass: RefuseEverything }],
          },
        ],
        VariantModule,
      );
    }
    return "VariantModule";
  },
});

exports.createPlugin = function createPlugin() {
  return { module: VariantModule };
};
`;

let prisma: PrismaClient | undefined;
let app: NestFastifyApplication | undefined;
let workspace: string | undefined;
let previousDataDir: string | undefined;

/** The running application, or the setup failure already in the report. */
function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

beforeAll(async () => {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  prisma = client;
  const registry = new PluginRegistryService(
    client as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
  );

  const created = await mkdtemp(
    join(tmpdir(), "openbrf-plugin-module-registration-"),
  );
  workspace = created;
  const directory = join(
    dataPaths(created).plugins,
    "node_modules",
    `openbrf-plugin-${VARIANT}`,
  );
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: `openbrf-plugin-${VARIANT}`,
      version: "1.0.0",
      openbrf: {
        apiVersion: 1,
        id: VARIANT,
        entry: { server: "./dist/server.cjs" },
        permissions: [],
        personalData: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "dist", "server.cjs"),
    VARIANT_BUNDLE,
    "utf8",
  );

  await client.installedPlugin.deleteMany({ where: { id: VARIANT } });
  await registry.consent({
    id: VARIANT,
    packageName: `openbrf-plugin-${VARIANT}`,
    version: "1.0.0",
    tarballUrl: `file:///dev/null/${VARIANT}.tgz`,
    checksum: "sha512-unused-in-this-suite",
    permissions: [],
    personalData: [],
    actions: [],
    ai: false,
    licence: null,
  });

  // Set on the environment as well as passed in: the application's own
  // configuration module reads process.env when the container is built.
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
}, 120_000);

afterAll(async () => {
  // Unguarded beyond what may not exist, as the bootstrap suite's teardown
  // is, and for its reasons.
  try {
    if (app !== undefined) {
      await app.close();
    }
    if (prisma !== undefined) {
      const client = prisma;
      try {
        await client.installedPlugin.deleteMany({ where: { id: VARIANT } });
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

describe("booting with a plugin that imports a module of the application's class it never declared", () => {
  it("does not let the module act on the application's routes", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });

  it("reports the plugin as refused rather than running it", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(VARIANT)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === VARIANT);
    expect(finding?.reason).toBe("module-refused");
  });
});

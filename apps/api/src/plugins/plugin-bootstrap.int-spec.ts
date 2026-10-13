import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

/*
 * Per-run identifiers. This suite writes its own packages and its own consent
 * rows and cleans them up by id, so a fixed id makes two overlapping runs each
 * other's teardown - and the failure that produces names a plugin neither run
 * was testing. The fixture suite is the one that cannot do this: the id it
 * installs is the one its catalog entry declares.
 */
const SUFFIX = runSuffix();
const GOOD = `bootstrap-good-${SUFFIX}`;
const UNBUILDABLE = `bootstrap-unbuildable-${SUFFIX}`;
const CONFIGURING = `bootstrap-configuring-${SUFFIX}`;
const SHADOWING = `bootstrap-shadowing-${SUFFIX}`;
const REPOINTING = `bootstrap-repointing-${SUFFIX}`;
const REWRITING = `bootstrap-rewriting-${SUFFIX}`;
const THROWING = `bootstrap-throwing-${SUFFIX}`;
const ALL_IDS = [
  GOOD,
  UNBUILDABLE,
  CONFIGURING,
  SHADOWING,
  REPOINTING,
  REWRITING,
  THROWING,
];

/** The header the configuring plugin's middleware would put on every response. */
const MIDDLEWARE_HEADER = "x-bootstrap-configuring";

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

/**
 * A module with no middleware on its class, which its constructor then gives
 * the instance. The seal reads the class; NestJS asks the instance.
 */
const CONFIGURING_BUNDLE = `const { Module } = require("@nestjs/common");

class ConfiguringModule {
  constructor() {
    this.configure = (consumer) => {
      consumer
        .apply((request, reply, next) => {
          reply.setHeader("${MIDDLEWARE_HEADER}", "1");
          next();
        })
        .forRoutes("*");
    };
  }
}
Module({})(ConfiguringModule);

exports.createPlugin = function createPlugin() {
  return { module: ConfiguringModule };
};
`;

/**
 * A controller whose instance holds its own function under the name of its
 * sealed route method, carrying the mark the seal clears on the prototype's.
 */
const SHADOWING_BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

function standIn() {
  return { shadowed: true };
}
Reflect.defineMetadata("openbrf:public-route", true, standIn);

class ShadowingController {
  constructor() {
    this.ping = standIn;
  }

  ping() {
    return { shadowed: false };
  }
}
Get("ping")(
  ShadowingController.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(ShadowingController.prototype, "ping"),
);
Controller()(ShadowingController);

class ShadowingModule {}
Module({})(ShadowingModule);

exports.createPlugin = function createPlugin() {
  return { module: ShadowingModule, controllers: [ShadowingController] };
};
`;

/**
 * The configuring module again, whose constructor also points the plugin's
 * module object at a class with nothing in it, so that a check reading that
 * object would look at the wrong module.
 */
const REPOINTING_BUNDLE = `const { Module } = require("@nestjs/common");

const contributed = {};

class EmptyModule {}
Module({})(EmptyModule);

class RepointingModule {
  constructor() {
    this.configure = (consumer) => {
      consumer
        .apply((request, reply, next) => {
          reply.setHeader("${MIDDLEWARE_HEADER}", "1");
          next();
        })
        .forRoutes("*");
    };
    contributed.module = EmptyModule;
  }
}
Module({})(RepointingModule);

exports.createPlugin = function createPlugin() {
  contributed.module = RepointingModule;
  return contributed;
};
`;

/**
 * A controller whose constructor puts a function of its own on its class's
 * prototype under the sealed route's name, carrying the mark the seal clears.
 */
const REWRITING_BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

function standIn() {
  return { rewritten: true };
}
Reflect.defineMetadata("openbrf:public-route", true, standIn);

class RewritingController {
  constructor() {
    Object.getPrototypeOf(this).ping = standIn;
  }

  ping() {
    return { rewritten: false };
  }
}
Get("ping")(
  RewritingController.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(RewritingController.prototype, "ping"),
);
Controller()(RewritingController);

class RewritingModule {}
Module({})(RewritingModule);

exports.createPlugin = function createPlugin() {
  return { module: RewritingModule, controllers: [RewritingController] };
};
`;

/**
 * A module the seal refuses outright: the object `createPlugin` returns has an
 * enumerable getter, unrelated to the module, that would throw if it were read.
 * The seal copies that object without calling a getter, so it is refused
 * unread.
 */
const THROWING_BUNDLE = `const { Module } = require("@nestjs/common");

class ThrowingModule {}
Module({})(ThrowingModule);

exports.createPlugin = function createPlugin() {
  return {
    module: ThrowingModule,
    get unrelated() {
      throw new Error("bootstrap-throwing-secret");
    },
  };
};
`;

let prisma: PrismaClient | undefined;
let registry: PluginRegistryService;
let app: NestFastifyApplication | undefined;
let workspace: string | undefined;
let previousDataDir: string | undefined;
/** What the bootstrap logged about the plugin it dropped. */
let errors = "";
/** What it logged about the plugins it refused once they were built. */
let refusals = "";

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
  await writePackage(modules, CONFIGURING, CONFIGURING_BUNDLE);
  await writePackage(modules, SHADOWING, SHADOWING_BUNDLE);
  await writePackage(modules, REPOINTING, REPOINTING_BUNDLE);
  await writePackage(modules, REWRITING, REWRITING_BUNDLE);
  await writePackage(modules, THROWING, THROWING_BUNDLE);

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
      actions: [],
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

  // Recorded rather than replaced, so the run's own output is unchanged and
  // the assertions below can read what the dropped plugin put in the log.
  const error = vi.spyOn(Logger.prototype, "error");
  let started: NestFastifyApplication;
  try {
    started = await createApplication(await loadPluginsAtBoot(testEnv));
  } finally {
    errors = JSON.stringify(
      error.mock.calls.filter((call) =>
        String(call[0]).includes("could not be built into the application"),
      ),
    );
    refusals = JSON.stringify(
      error.mock.calls.filter((call) =>
        String(call[0]).includes("was refused after its module was built"),
      ),
    );
    error.mockRestore();
  }
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

  /**
   * Nor into the log, which is the part no other control covers. What it does
   * carry is the plugin and the class of the failure, so an operator has the
   * two things that place it.
   */
  it("logs the plugin and the class of the failure, not its message", () => {
    expect(errors).not.toContain("NeedsAbsent");
    expect(errors).toContain(UNBUILDABLE);
    expect(errors).toContain("Error");
  });

  it("does not serve the dropped plugin's routes", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${UNBUILDABLE}/go` });

    expect(response.statusCode).toBe(404);
  });
});

describe("booting with a plugin whose returned object keeps a getter that throws", () => {
  it("starts anyway, with the core and the good plugin available", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(application().get(PluginLoaderService).get(GOOD)).not.toBeNull();
  });

  it("skips the plugin and reports it as not a dynamic module", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(THROWING)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === THROWING);
    expect(finding?.reason).toBe("module-invalid");
    expect(finding?.detail).toEqual({});
    expect(JSON.stringify(loader.report())).not.toContain(
      "bootstrap-throwing-secret",
    );
  });
});

/**
 * Plugins whose classes pass the seal and whose instances do not. Both are
 * built without error, so nothing but the check on the built container keeps
 * them out, and before it each was serving.
 */
describe("booting with a plugin whose built module is not what was sealed", () => {
  it("refuses a module whose instance registers middleware", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(CONFIGURING)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === CONFIGURING);
    expect(finding?.reason).toBe("module-refused");
    expect(finding?.detail).toEqual({});
  });

  it("runs none of that middleware on the application's own routes", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers[MIDDLEWARE_HEADER]).toBeUndefined();
  });

  it("refuses a controller whose instance stands in for a route method", async () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(SHADOWING)).toBeNull();
    expect(
      loader.report().find((entry) => entry.id === SHADOWING)?.reason,
    ).toBe("module-refused");

    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${SHADOWING}/ping` });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a module that points its plugin's module object elsewhere once built", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(REPOINTING)).toBeNull();
    expect(
      loader.report().find((entry) => entry.id === REPOINTING)?.reason,
    ).toBe("module-refused");
  });

  it("refuses a controller whose constructor replaces a route method on its class", async () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(REWRITING)).toBeNull();
    expect(
      loader.report().find((entry) => entry.id === REWRITING)?.reason,
    ).toBe("module-refused");

    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${REWRITING}/ping` });
    expect(response.statusCode).toBe(404);
  });

  it("logs each refused plugin and what it broke", () => {
    expect(refusals).toContain(CONFIGURING);
    expect(refusals).toContain("registers middleware");
    expect(refusals).toContain(SHADOWING);
    expect(refusals).toContain("sealed method");
    expect(refusals).toContain(REPOINTING);
    expect(refusals).toContain(REWRITING);
    expect(refusals).toContain("the seal did not read");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

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
const MIDDLEWARE = `bootstrap-middleware-${SUFFIX}`;
const CHANGED = `bootstrap-changed-${SUFFIX}`;
const UNDONE = `bootstrap-undone-${SUFFIX}`;
const SHADOWING = `bootstrap-shadowing-${SUFFIX}`;
const SUBSTITUTING = `bootstrap-substituting-${SUFFIX}`;
const REWRITING = `bootstrap-rewriting-${SUFFIX}`;
const REPOINTING = `bootstrap-repointing-${SUFFIX}`;
const LATE = `bootstrap-late-${SUFFIX}`;
const ALL_IDS = [
  GOOD,
  UNBUILDABLE,
  MIDDLEWARE,
  CHANGED,
  UNDONE,
  SHADOWING,
  SUBSTITUTING,
  REWRITING,
  REPOINTING,
  LATE,
];

/** Where the late bundle leaves the change it makes once it is checked. */
const LATE_CHANGE = Symbol.for(`openbrf.test.${LATE}`);

/**
 * A module whose class declares no middleware and whose instance does: its
 * constructor gives it a `configure`, which is where NestJS looks.
 */
const MIDDLEWARE_BUNDLE = `const { Module } = require("@nestjs/common");

class MiddlewareModule {
  constructor() {
    this.configure = (consumer) => {
      consumer
        .apply((request, response, next) => {
          response.setHeader("x-plugin-middleware", "ran");
          next();
        })
        .forRoutes("*");
    };
  }
}
Module({})(MiddlewareModule);

exports.createPlugin = function createPlugin() {
  return { module: MiddlewareModule };
};
`;

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

/**
 * A module that is harmless when it is sealed and changes once it has been: a
 * timer its factory leaves behind gives it an application-wide guard that
 * refuses every request. Both ways at once - into the list it returned, which
 * the seal froze, and as a new list in the class's metadata, which a class
 * cannot be frozen against.
 */
const CHANGED_BUNDLE = `const { Injectable, Module } = require("@nestjs/common");

class RefuseEverything {
  canActivate() {
    return false;
  }
}
Injectable()(RefuseEverything);

class ChangedModule {}
Module({})(ChangedModule);

exports.createPlugin = function createPlugin() {
  const providers = [];
  const guard = { provide: "APP_GUARD", useClass: RefuseEverything };
  setImmediate(() => {
    try {
      providers.push(guard);
    } catch {
      // Frozen by the seal.
    }
    Reflect.defineMetadata("providers", [guard], ChangedModule);
  });
  return { module: ChangedModule, providers };
};
`;

/**
 * A module that changes while NestJS builds it and undoes the change before
 * the build is over. NestJS reads the module class's name as it registers it,
 * and a getter there gives an imported module an application-wide guard that
 * refuses every request; the guard's constructor takes it away again. Nothing
 * read before or after the build finds it.
 *
 * Changed as NestJS registers the module, which it does once in every build:
 * the application is built again after a plugin fails a build, and a change
 * made only in the first would leave the build that is served unchanged.
 */
const UNDONE_BUNDLE = `const { Injectable, Module } = require("@nestjs/common");

class InnerModule {}
Module({})(InnerModule);

class RefuseEverything {
  constructor() {
    Reflect.deleteMetadata("providers", InnerModule);
  }
  canActivate() {
    return false;
  }
}
Injectable()(RefuseEverything);

class UndoneModule {}
Module({ imports: [InnerModule] })(UndoneModule);
Object.defineProperty(UndoneModule, "name", {
  get() {
    if (new Error().stack.includes("addModuleAsProvider")) {
      Reflect.defineMetadata(
        "providers",
        [{ provide: "APP_GUARD", useClass: RefuseEverything }],
        InnerModule,
      );
    }
    return "UndoneModule";
  },
});

exports.createPlugin = function createPlugin() {
  return { module: UndoneModule };
};
`;

/**
 * A controller whose instance holds its own function under the name of its
 * sealed route, carrying the mark the seal clears on the prototype's.
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
 * A controller whose constructor returns an object of another class, with a
 * route of its own the seal never read.
 */
const SUBSTITUTING_BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

class Elsewhere {
  ping() {
    return { substituted: true };
  }
}
Get("ping")(
  Elsewhere.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(Elsewhere.prototype, "ping"),
);
Reflect.defineMetadata(
  "openbrf:public-route",
  true,
  Elsewhere.prototype.ping,
);

class SubstitutingController {
  constructor() {
    return new Elsewhere();
  }
}
Controller()(SubstitutingController);

class SubstitutingModule {}
Module({})(SubstitutingModule);

exports.createPlugin = function createPlugin() {
  return { module: SubstitutingModule, controllers: [SubstitutingController] };
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
 * A module whose constructor gives its instance a `configure` and points
 * the plugin's module object at a class with nothing in it, so that a check
 * reading that object would look at the wrong module.
 */
const REPOINTING_BUNDLE = `const { Module } = require("@nestjs/common");

const contributed = {};

class EmptyModule {}
Module({})(EmptyModule);

class RepointingModule {
  constructor() {
    this.configure = (consumer) => {
      consumer
        .apply((request, response, next) => {
          response.setHeader("x-plugin-middleware", "ran");
          next();
        })
        .forRoutes("*");
    };
    try {
      contributed.module = EmptyModule;
    } catch {
      // Fixed by the seal; the middleware is what is left to try.
    }
  }
}
Module({})(RepointingModule);

exports.createPlugin = function createPlugin() {
  contributed.module = RepointingModule;
  return contributed;
};
`;

/**
 * Two controllers whose served routes are the ones they were checked with:
 * only the checked handler on each checked route answers, every other method
 * of a controller answers 404, and so does a checked handler reached on a path
 * or under a name it was not checked with.
 *
 * Every method the change reaches is made public once it is checked, so a
 * route that served it would answer the suite's anonymous requests. One
 * controller inherits a route from a base class the bundle defines, which the
 * change reaches as well.
 */
const LATE_BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

function exposed(handler) {
  Reflect.defineMetadata("openbrf:public-route", true, handler);
  return handler;
}

const standIn = exposed(function standIn() {
  return { late: true };
});

/** Gives a prototype a method of the plugin's, routed to path. */
function decoyOn(prototype, name, path) {
  const decoy = exposed(function decoy() {
    return { late: true };
  });
  Get(path)(prototype, name, { value: decoy });
  Reflect.defineProperty(prototype, name, { value: decoy });
}

/** The other controller's instance, as NestJS built it. */
let swapped;

class LateBase {
  inherited() {
    return { late: false };
  }
}
Get("inherited")(
  LateBase.prototype,
  "inherited",
  Object.getOwnPropertyDescriptor(LateBase.prototype, "inherited"),
);

class LateController extends LateBase {
  constructor() {
    super();
    globalThis[Symbol.for(${JSON.stringify(`openbrf.test.${LATE}`)})] = () => {
      const prototype = LateController.prototype;
      exposed(prototype.ping);
      Reflect.set(this, "ping", standIn);
      Reflect.defineProperty(prototype, "constructor", { value: Object });

      // A method added as a route.
      Reflect.defineProperty(prototype, "added", { value: standIn });
      Get("added")(prototype, "added", { value: standIn });

      // An inherited route made public, and a route added to the base class.
      exposed(LateBase.prototype.inherited);
      decoyOn(LateBase.prototype, "based", "based");

      // A method that is not a route made one.
      const helps = exposed(prototype.helps);
      Get("helps")(prototype, "helps", { value: helps });

      // The same, for a method that is not made public.
      Get("closed")(prototype, "closed", { value: prototype.closed });

      // A checked method moved to another path of the controller's.
      exposed(prototype.moving);
      decoyOn(prototype, "moving", "moved");

      // A checked method served for another request method. NestJS keeps a
      // route's request method under "method", and 1 is POST.
      Reflect.defineMetadata("method", 1, exposed(prototype.posting));

      // The controller served outside the plugin's prefix as well. NestJS
      // keeps a controller's path under "path".
      Reflect.defineMetadata(
        "path",
        [${JSON.stringify(`api/plugin/${LATE}`)}, "api/elsewhere"],
        LateController,
      );

      /*
       * The other controller's instance given a prototype of the plugin's,
       * whose methods NestJS has not read yet: one moving its checked method
       * to another path, and one serving it under another name, which the
       * instance holds as well.
       */
      const ping = exposed(SwappedController.prototype.ping);
      const detour = Object.create(SwappedController.prototype);
      decoyOn(detour, "ping", "detour");
      decoyOn(detour, "alias", "alias");
      Reflect.set(swapped, "alias", ping);
      Reflect.setPrototypeOf(swapped, detour);
      return this;
    };
  }

  ping() {
    return { late: false };
  }

  moving() {
    return { late: false };
  }

  posting() {
    return { late: false };
  }

  helps() {
    return { late: true };
  }

  closed() {
    return { late: true };
  }
}
for (const name of ["ping", "moving", "posting"]) {
  Get(name)(
    LateController.prototype,
    name,
    Object.getOwnPropertyDescriptor(LateController.prototype, name),
  );
}
Controller()(LateController);

class SwappedController {
  constructor() {
    swapped = this;
  }

  ping() {
    return { late: false };
  }
}
Get("ping")(
  SwappedController.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(SwappedController.prototype, "ping"),
);
Controller("swapped")(SwappedController);

class LateModule {}
Module({})(LateModule);

exports.createPlugin = function createPlugin() {
  return { module: LateModule, controllers: [LateController, SwappedController] };
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
/** What the bootstrap logged about the plugin it dropped. */
let errors = "";
/** What it logged about the plugins it refused. */
let refusals = "";
/** The late bundle's controller, once its change is made. */
let lateController: unknown;

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
  await writePackage(modules, MIDDLEWARE, MIDDLEWARE_BUNDLE);
  await writePackage(modules, CHANGED, CHANGED_BUNDLE);
  await writePackage(modules, UNDONE, UNDONE_BUNDLE);
  await writePackage(modules, SHADOWING, SHADOWING_BUNDLE);
  await writePackage(modules, SUBSTITUTING, SUBSTITUTING_BUNDLE);
  await writePackage(modules, REWRITING, REWRITING_BUNDLE);
  await writePackage(modules, REPOINTING, REPOINTING_BUNDLE);
  await writePackage(modules, LATE, LATE_BUNDLE);

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
      recipients: [],
      deviceRoutes: [],
      ai: false,
      licence: null,
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
  const warn = vi.spyOn(Logger.prototype, "warn");
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
      warn.mock.calls.filter((call) => String(call[0]).includes("not loaded")),
    );
    error.mockRestore();
    warn.mockRestore();
  }
  app = started;
  // Left by the controller of the last build, which is the one served.
  const lateChange: unknown = Reflect.get(globalThis, LATE_CHANGE);
  Reflect.deleteProperty(globalThis, LATE_CHANGE);
  if (typeof lateChange !== "function") {
    throw new Error("The late bundle's controller was not built.");
  }
  lateController = lateChange();
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

describe("booting with a plugin whose built module registers middleware", () => {
  it("does not run the middleware on the application's routes", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-plugin-middleware"]).toBeUndefined();
  });

  it("reports the plugin as refused rather than running it", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(MIDDLEWARE)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === MIDDLEWARE);
    expect(finding?.reason).toBe("module-refused");
    expect(loader.manifestFor(MIDDLEWARE)).not.toBeNull();
  });

  it("keeps serving the plugin that does build", () => {
    expect(application().get(PluginLoaderService).get(GOOD)).not.toBeNull();
  });
});

describe("booting with a plugin that changes its module once it is sealed", () => {
  it("does not let the change act on the application's routes", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });

  it("reports the plugin as refused rather than running it", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(CHANGED)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === CHANGED);
    expect(finding?.reason).toBe("module-refused");
  });

  it("keeps serving the plugin that does build", () => {
    expect(application().get(PluginLoaderService).get(GOOD)).not.toBeNull();
  });
});

describe("booting with a plugin that changes its module while it is built", () => {
  it("does not let the change act on the application's routes", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });

  it("reports the plugin as refused rather than running it", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(UNDONE)).toBeNull();
    const finding = loader.report().find((entry) => entry.id === UNDONE);
    expect(finding?.reason).toBe("module-refused");
  });
});

/**
 * Plugins whose controller classes pass the seal and whose instances, or
 * whose classes once their constructors have run, do not. Each is built
 * without error, so nothing but the check on what was built keeps it out.
 */
describe("booting with a plugin whose controller is not built as it was sealed", () => {
  it.each([
    ["holds its own function under a route's name", SHADOWING],
    ["is built as an object of another class", SUBSTITUTING],
    ["replaces a route on its class while it is built", REWRITING],
  ])(
    "refuses a controller that %s, and serves none of its routes",
    async (_, id) => {
      const loader = application().get(PluginLoaderService);

      expect(loader.get(id)).toBeNull();
      const finding = loader.report().find((entry) => entry.id === id);
      expect(finding?.reason).toBe("module-refused");

      const response = await application()
        .getHttpAdapter()
        .getInstance()
        .inject({ method: "GET", url: `/api/plugin/${id}/ping` });
      expect(response.statusCode).toBe(404);
    },
  );

  it("refuses a module that points its plugin's module object elsewhere once built", async () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(REPOINTING)).toBeNull();
    expect(
      loader.report().find((entry) => entry.id === REPOINTING)?.reason,
    ).toBe("module-refused");

    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });
    expect(response.headers["x-plugin-middleware"]).toBeUndefined();
  });

  it("logs each refused plugin and what it was built into", () => {
    expect(refusals).toContain(SHADOWING);
    expect(refusals).toContain("was built holding its own `ping`");
    expect(refusals).toContain(SUBSTITUTING);
    expect(refusals).toContain("something other than an instance");
    expect(refusals).toContain(REWRITING);
    expect(refusals).toContain("changed its `methods`");
    expect(refusals).toContain(REPOINTING);
  });

  it("keeps serving the plugin that does build", () => {
    expect(application().get(PluginLoaderService).get(GOOD)).not.toBeNull();
  });
});

/**
 * A plugin whose controller passes the check and whose code changes it
 * afterwards, before the application mounts its routes. The instance is fixed
 * as it was checked, so the change reaches neither the router nor the guard.
 */
describe("booting with a plugin that changes its controller once it is checked", () => {
  it("serves it", () => {
    expect(application().get(PluginLoaderService).get(LATE)).not.toBeNull();
  });

  it.each(["ping", "inherited", "swapped/ping"])(
    "serves %s as it was checked, needing a sign-in though it was made public afterwards",
    async (path) => {
      const response = await application()
        .getHttpAdapter()
        .getInstance()
        .inject({ method: "GET", url: `/api/plugin/${LATE}/${path}` });

      expect(response.statusCode).toBe(401);
    },
  );

  it.each([
    ["on another path of its controller's", `/api/plugin/${LATE}/moved`],
    ["outside the plugin's prefix", "/api/elsewhere/ping"],
    ["under another name", `/api/plugin/${LATE}/swapped/alias`],
    [
      "from a prototype the instance was given",
      `/api/plugin/${LATE}/swapped/detour`,
    ],
  ])("does not serve a checked method %s", async (_, url) => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('"late"');
  });

  it("does not serve a checked method for a request method it was not checked with", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "POST", url: `/api/plugin/${LATE}/posting` });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('"late"');
  });

  it.each(["added", "based", "helps"])(
    "does not serve the method it made a route as %s afterwards",
    async (path) => {
      const response = await application()
        .getHttpAdapter()
        .getInstance()
        .inject({ method: "GET", url: `/api/plugin/${LATE}/${path}` });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('"late":true');
    },
  );

  it("answers a method it made a route without a sign-in as not served, not as unauthorized", async () => {
    const response = await application()
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: `/api/plugin/${LATE}/closed` });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('"late"');
  });

  it("keeps the base class the bundle defines as it was checked", () => {
    const base: unknown = Object.getPrototypeOf(
      Object.getPrototypeOf(lateController),
    );

    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.getOwnPropertyNames(base)).not.toContain("based");
  });

  it("tells the guard the class the seal read", () => {
    expect(
      (lateController as { constructor: { name: string } }).constructor.name,
    ).toBe("LateController");
  });
});

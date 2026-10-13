import {
  Controller,
  type DynamicModule,
  Get,
  Global,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Scope,
} from "@nestjs/common";
import { ModulesContainer, NestFactory, REQUEST } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { type InstanceFault, refusedInstance } from "./plugin-instances";
import { type SealedModule, sealPluginModule } from "./plugin-module-seal";

/**
 * What the host checks once NestJS has built a plugin's module.
 *
 * Every refused shape below gets past a check on the class, because it is a
 * constructor or a class field that puts it there, and neither runs until the
 * container is built. The decisive assertions are that each is refused with
 * the right fault, and that the application's own modules - which register
 * middleware and could be request-scoped - are not held to the plugin's rules.
 *
 * Each plugin goes through the real seal first, because the check goes by
 * what the seal kept rather than by the plugin's module object. The
 * application is then built from the plugin's own objects rather than the
 * seal's copy, so that what is pinned here holds whatever NestJS is handed.
 */

function passThrough(): void {}

/** A route carrying the mark the seal clears on every plugin route. */
function marked(): string {
  return "marked";
}
Get()({}, "marked", { value: marked });
Reflect.defineMetadata(IS_PUBLIC_ROUTE, true, marked);

/** Middleware of the application's own, which is allowed. */
@Global()
@Module({})
class CoreGlobalModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(passThrough).forRoutes("*");
  }
}

@Controller({ path: "core", scope: Scope.REQUEST })
class CoreRequestController {
  @Get()
  read(): string {
    return "core";
  }
}

@Module({ controllers: [CoreRequestController] })
class CoreModule {}

/** The application's root, which declares its own modules as AppModule does. */
@Module({ imports: [CoreGlobalModule, CoreModule] })
class Root {}

/** A plugin that breaks no rule. New classes each time, as each is sealed once. */
function plain(): DynamicModule {
  @Controller("ping")
  class PlainController {
    @Get()
    ping(): string {
      return "pong";
    }

    helper(): string {
      return "not a route";
    }
  }

  @Module({})
  class PlainModule {}

  return { module: PlainModule, controllers: [PlainController] };
}

const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

interface Entry {
  index: number;
  sealed: SealedModule | null;
}

/** Seals each plugin as the boot does, failing the test if one is refused. */
function seal(plugins: readonly DynamicModule[]): Entry[] {
  return plugins.map((module, index) => {
    const result = sealPluginModule(module, {
      pluginId: `plugin-${String(index)}`,
      floor: "addressBook:read",
    });
    if (!result.ok) {
      throw new Error(result.log);
    }
    return { index, sealed: result.sealed };
  });
}

/** Builds the plugins into an application beside the core modules, then checks it. */
async function build(
  plugins: readonly DynamicModule[],
  entries: readonly Entry[],
): Promise<{ refused: number[]; fault: InstanceFault } | null> {
  const app = await NestFactory.createApplicationContext(
    { module: Root, imports: [...plugins] },
    { logger: false, abortOnError: false },
  );
  opened.push(app);
  const refused = refusedInstance(app.get(ModulesContainer), Root, entries);
  return refused === null
    ? null
    : {
        refused: refused.plugins.map((entry) => entry.index),
        fault: refused.fault,
      };
}

async function check(
  ...plugins: DynamicModule[]
): Promise<{ refused: number[]; fault: InstanceFault } | null> {
  return build(plugins, seal(plugins));
}

function plugin(
  module: DynamicModule["module"],
  rest: Omit<DynamicModule, "module"> = {},
): DynamicModule {
  return { module, ...rest };
}

describe("a plugin built as it was sealed", () => {
  it("passes, beside core modules that register middleware or are request-scoped", async () => {
    expect(await check(plain())).toBeNull();
  });

  it("passes beside other plugins and one without a module", async () => {
    const plugins = [plain(), plain()];
    const entries = [...seal(plugins), { index: 2, sealed: null }];

    expect(await build(plugins, entries)).toBeNull();
  });

  it("passes with constructor-injected fields on its controller", async () => {
    @Injectable()
    class Helper {}

    @Controller("helped")
    class HelpedController {
      constructor(@Inject(Helper) private readonly helper: Helper) {}

      @Get()
      read(): boolean {
        return this.helper instanceof Helper;
      }
    }

    @Module({})
    class HelpedModule {}

    expect(
      await check(
        plugin(HelpedModule, {
          controllers: [HelpedController],
          providers: [Helper],
        }),
      ),
    ).toBeNull();
  });

  it("passes when a subclass controller inherits its routes", async () => {
    class BaseController {
      @Get()
      ping(): string {
        return "pong";
      }
    }

    @Controller("derived")
    class DerivedController extends BaseController {}

    @Module({})
    class DerivedModule {}

    expect(
      await check(plugin(DerivedModule, { controllers: [DerivedController] })),
    ).toBeNull();
  });
});

describe("a plugin module that registers middleware on its instance", () => {
  it("is refused when its constructor assigns configure", async () => {
    @Module({})
    class AssigningModule {
      constructor() {
        Object.assign(this, {
          configure(consumer: MiddlewareConsumer) {
            consumer.apply(passThrough).forRoutes("*");
          },
        });
      }
    }

    expect(await check(plugin(AssigningModule))).toEqual({
      refused: [0],
      fault: "middleware",
    });
  });

  it("is refused when configure is a class field", async () => {
    @Module({})
    class FieldModule {
      configure = (consumer: MiddlewareConsumer): void => {
        consumer.apply(passThrough).forRoutes("*");
      };
    }

    expect(await check(plugin(FieldModule))).toEqual({
      refused: [0],
      fault: "middleware",
    });
  });

  it("is refused when the module is one the plugin's module imports", async () => {
    @Module({})
    class InnerModule {
      constructor() {
        Object.assign(this, { configure: passThrough });
      }
    }

    @Module({ imports: [InnerModule] })
    class OuterModule {}

    expect(await check(plugin(OuterModule))).toEqual({
      refused: [0],
      fault: "middleware",
    });
  });

  it("is refused when one of its providers sets configure on the module", async () => {
    @Module({})
    class TargetModule {}

    @Injectable()
    class Setter {
      constructor(@Inject(TargetModule) target: TargetModule) {
        Object.assign(target, { configure: passThrough });
      }
    }

    expect(await check(plugin(TargetModule, { providers: [Setter] }))).toEqual({
      refused: [0],
      fault: "middleware",
    });
  });

  it("is refused when its instance is a proxy", async () => {
    @Module({})
    class ProxiedModule {
      constructor() {
        return new Proxy(this, {});
      }
    }

    expect(await check(plugin(ProxiedModule))).toEqual({
      refused: [0],
      fault: "middleware",
    });
  });
});

describe("a plugin controller whose instance is not what was sealed", () => {
  it("is refused when a class field stands in for a route method", async () => {
    @Controller("field")
    class FieldController {
      handle = marked;
    }
    // The route method the field stands in for. A class cannot declare both
    // under one name, so the method is put on the prototype by hand.
    Object.defineProperty(FieldController.prototype, "handle", {
      value: function handle(): string {
        return "sealed";
      },
      configurable: true,
      writable: true,
    });
    Get()(
      FieldController.prototype,
      "handle",
      Object.getOwnPropertyDescriptor(FieldController.prototype, "handle")!,
    );

    @Module({})
    class FieldModule {}

    expect(
      await check(plugin(FieldModule, { controllers: [FieldController] })),
    ).toEqual({ refused: [0], fault: "method" });
  });

  it("is refused when its constructor returns an object of another class", async () => {
    class Elsewhere {
      @Get()
      handle(): string {
        return "unsealed";
      }
    }

    @Controller("substituted")
    class SubstitutedController {
      constructor() {
        return new Elsewhere();
      }
    }

    @Module({})
    class SubstitutedModule {}

    expect(
      await check(
        plugin(SubstitutedModule, { controllers: [SubstitutedController] }),
      ),
    ).toEqual({ refused: [0], fault: "class" });
  });

  it("is refused when its constructor returns a proxy of itself", async () => {
    @Controller("proxied")
    class ProxiedController {
      constructor() {
        return new Proxy(this, {});
      }

      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class ProxiedModule {}

    expect(
      await check(plugin(ProxiedModule, { controllers: [ProxiedController] })),
    ).toEqual({ refused: [0], fault: "class" });
  });

  it("is refused when its instance names another class as its constructor", async () => {
    class Other {}

    @Controller("renamed")
    class RenamedController {
      constructor() {
        Object.defineProperty(this, "constructor", { value: Other });
      }

      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class RenamedModule {}

    expect(
      await check(plugin(RenamedModule, { controllers: [RenamedController] })),
    ).toEqual({ refused: [0], fault: "method" });
  });

  it("is refused when its prototype names another class as its constructor", async () => {
    class Other {}

    @Controller("reassigned")
    class ReassignedController {
      @Get()
      handle(): string {
        return "sealed";
      }
    }
    Object.defineProperty(ReassignedController.prototype, "constructor", {
      value: Other,
    });

    @Module({})
    class ReassignedModule {}

    expect(
      await check(
        plugin(ReassignedModule, { controllers: [ReassignedController] }),
      ),
    ).toEqual({ refused: [0], fault: "class" });
  });
});

describe("a plugin controller whose class is not what was sealed", () => {
  it("is refused when its constructor replaces a route method on the prototype", async () => {
    @Controller("rewritten")
    class RewrittenController {
      constructor() {
        Object.assign(Object.getPrototypeOf(this) as object, {
          handle: marked,
        });
      }

      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class RewrittenModule {}

    expect(
      await check(
        plugin(RewrittenModule, { controllers: [RewrittenController] }),
      ),
    ).toEqual({ refused: [0], fault: "prototype" });
  });

  it("is refused when its constructor replaces a route method with a non-function", async () => {
    @Controller("removed")
    class RemovedController {
      constructor() {
        Object.assign(Object.getPrototypeOf(this) as object, {
          handle: undefined,
        });
      }

      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class RemovedModule {}

    expect(
      await check(plugin(RemovedModule, { controllers: [RemovedController] })),
    ).toEqual({ refused: [0], fault: "prototype" });
  });

  it("is refused when its constructor adds a route method to the prototype", async () => {
    @Controller("added")
    class AddedController {
      constructor() {
        Object.assign(Object.getPrototypeOf(this) as object, { marked });
      }

      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class AddedModule {}

    expect(
      await check(plugin(AddedModule, { controllers: [AddedController] })),
    ).toEqual({ refused: [0], fault: "prototype" });
  });
});

describe("a plugin controller that is not a singleton", () => {
  it("is refused when it is request-scoped", async () => {
    @Controller({ path: "scoped", scope: Scope.REQUEST })
    class ScopedController {
      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class ScopedModule {}

    expect(
      await check(plugin(ScopedModule, { controllers: [ScopedController] })),
    ).toEqual({ refused: [0], fault: "scope" });
  });

  it("is refused when it depends on something request-scoped", async () => {
    @Controller("dependent")
    class DependentController {
      constructor(@Inject(REQUEST) readonly request: unknown) {}

      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class DependentModule {}

    expect(
      await check(
        plugin(DependentModule, { controllers: [DependentController] }),
      ),
    ).toEqual({ refused: [0], fault: "scope" });
  });

  it("is refused when it is transient", async () => {
    @Controller({ path: "transient", scope: Scope.TRANSIENT })
    class TransientController {
      @Get()
      handle(): string {
        return "sealed";
      }
    }

    @Module({})
    class TransientModule {}

    expect(
      await check(
        plugin(TransientModule, { controllers: [TransientController] }),
      ),
    ).toEqual({ refused: [0], fault: "scope" });
  });
});

describe("attributing a refusal", () => {
  it("names the plugin at fault, not the first one installed", async () => {
    @Module({})
    class LaterModule {
      configure = passThrough;
    }

    expect(await check(plain(), plugin(LaterModule))).toEqual({
      refused: [1],
      fault: "middleware",
    });
  });

  it("refuses every plugin when the root imports a module none of them was sealed with", async () => {
    @Module({})
    class Shown {}

    @Module({})
    class Built {
      constructor() {
        Object.assign(this, { configure: passThrough });
      }
    }

    const shifting: DynamicModule = { module: Shown };
    const plugins = [plain(), shifting];
    const entries = seal(plugins);
    shifting.module = Built;

    expect(await build(plugins, entries)).toEqual({
      refused: [0, 1],
      fault: "unattributed",
    });
  });
});

/**
 * The check goes by the classes the seal read. A plugin's module object is
 * the plugin's own, and what it names can change between the seal and the
 * check - including from the constructors the build runs.
 */
describe("a plugin whose module object no longer names what was sealed", () => {
  it("is refused when its module's constructor repoints the object at another class", async () => {
    @Module({})
    class Decoy {}

    const repointed: DynamicModule = { module: Decoy };

    @Module({})
    class RepointingModule {
      constructor() {
        Object.assign(this, { configure: passThrough });
        repointed.module = Decoy;
      }
    }
    repointed.module = RepointingModule;

    expect(await check(repointed)).toEqual({
      refused: [0],
      fault: "middleware",
    });
  });

  it("is refused when its module's constructor repoints an import it shares with the seal's copy", async () => {
    @Module({})
    class Decoy {}

    // The seal copies the root object only, so this one is the plugin's still.
    const inner: DynamicModule = { module: Decoy };

    @Module({})
    class RepointingInner {
      constructor() {
        Object.assign(this, { configure: passThrough });
        inner.module = Decoy;
      }
    }
    inner.module = RepointingInner;

    @Module({})
    class Outer {}

    expect(await check(plugin(Outer, { imports: [inner] }))).toEqual({
      refused: [0],
      fault: "middleware",
    });
  });

  it("is refused when NestJS is shown one of the application's modules instead", async () => {
    @Module({})
    class Shown {}

    const shifting: DynamicModule = { module: Shown };
    const entries = seal([shifting]);
    shifting.module = CoreModule;

    expect(await build([shifting], entries)).toEqual({
      refused: [0],
      fault: "module",
    });
  });

  it("is refused when NestJS is shown an import the seal never read", async () => {
    @Module({})
    class ShownInner {}

    @Module({})
    class BuiltInner {}

    @Module({})
    class Outer {}

    const shifting: DynamicModule = { module: Outer, imports: [ShownInner] };
    const entries = seal([shifting]);
    shifting.imports = [BuiltInner];

    expect(await build([shifting], entries)).toEqual({
      refused: [0],
      fault: "module",
    });
  });
});

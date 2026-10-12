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

/**
 * What the host checks once NestJS has built a plugin's module.
 *
 * Every refused shape below gets past a check on the class, because it is a
 * constructor or a class field that puts it there, and neither runs until the
 * container is built. The decisive assertions are that each is refused with
 * the right fault, and that the application's own modules - which register
 * middleware and could be request-scoped - are not held to the plugin's rules.
 */

function passThrough(): void {}

/** A handler carrying the mark the seal clears on every plugin route. */
function marked(): string {
  return "marked";
}
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

@Module({})
class Root {}

@Controller("ping")
class PlainController {
  @Get()
  ping(): string {
    return "pong";
  }
}

@Module({})
class PlainModule {}

const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

/** Builds the plugins into an application beside the core modules, then checks it. */
async function check(
  ...plugins: DynamicModule[]
): Promise<{ index: number; fault: InstanceFault } | null> {
  const app = await NestFactory.createApplicationContext(
    { module: Root, imports: [CoreGlobalModule, CoreModule, ...plugins] },
    { logger: false, abortOnError: false },
  );
  opened.push(app);
  const entries = plugins.map((module, index) => ({ module, index }));
  const refused = refusedInstance(app.get(ModulesContainer), Root, entries);
  return refused === null
    ? null
    : { index: refused.plugin.index, fault: refused.fault };
}

function plugin(
  module: DynamicModule["module"],
  rest: Omit<DynamicModule, "module"> = {},
): DynamicModule {
  return { module, ...rest };
}

describe("a plugin built as it was sealed", () => {
  it("passes, beside core modules that register middleware or are request-scoped", async () => {
    expect(
      await check(plugin(PlainModule, { controllers: [PlainController] })),
    ).toBeNull();
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
      index: 0,
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
      index: 0,
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
      index: 0,
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
      index: 0,
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
      index: 0,
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
    ).toEqual({ index: 0, fault: "method" });
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
    ).toEqual({ index: 0, fault: "class" });
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
    ).toEqual({ index: 0, fault: "class" });
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
    ).toEqual({ index: 0, fault: "method" });
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
    ).toEqual({ index: 0, fault: "class" });
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
    ).toEqual({ index: 0, fault: "scope" });
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
    ).toEqual({ index: 0, fault: "scope" });
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
    ).toEqual({ index: 0, fault: "scope" });
  });
});

describe("attributing a refusal", () => {
  it("names the plugin at fault, not the first one installed", async () => {
    @Module({})
    class LaterModule {
      configure = passThrough;
    }

    expect(
      await check(
        plugin(PlainModule, { controllers: [PlainController] }),
        plugin(LaterModule),
      ),
    ).toEqual({ index: 1, fault: "middleware" });
  });
});

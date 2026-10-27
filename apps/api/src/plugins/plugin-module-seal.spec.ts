import {
  All,
  Body,
  type CanActivate,
  Controller,
  Delete,
  type DynamicModule,
  forwardRef,
  Get,
  Global,
  Inject,
  Injectable,
  type INestApplicationContext,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Post,
  type Provider,
  Scope,
  SetMetadata,
  type Type,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from "@nestjs/common";
import {
  GLOBAL_MODULE_METADATA,
  GUARDS_METADATA,
  HOST_METADATA,
  PATH_METADATA,
  PROPERTY_DEPS_METADATA,
  ROUTE_ARGS_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from "@nestjs/common/constants";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  ModulesContainer,
  NestFactory,
  Reflector,
  REQUEST,
} from "@nestjs/core";
import { Injector } from "@nestjs/core/injector/injector";
import { InternalCoreModule } from "@nestjs/core/internal";
import { describe, expect, it } from "vite-plus/test";

import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import {
  ALLOWED_INJECTIONS,
  DENIED_INJECTIONS,
  declaredModules,
  fixedController,
  hostModules,
  PLUGIN_ID_METADATA,
  rereadSealedModule,
  sealModuleInstances,
  sealPluginModule,
} from "./plugin-module-seal";

/**
 * What the host keeps over a plugin's own NestJS module.
 *
 * A plugin contributes real controllers, providers and guards, which is the
 * whole point of the contract and also the whole of its risk: a NestJS module
 * can declare things whose effect is application-wide. Everything asserted
 * here is a guarantee that used to be structural - the host served plugin
 * routes itself, so a plugin could not reach any of this - and now has to be
 * enforced.
 *
 * The decisive assertions are the refusals. A plugin that is rewritten is
 * running with the host's rules applied to it; a plugin that is refused is not
 * running at all, and either is acceptable. A plugin that got past both would
 * be able to serve a route the application's guard never saw.
 */

const OPTIONS = {
  pluginId: "occupancy",
  floor: ["addressBook:read"],
  source: "",
} as const;

/** What a plugin can be holding when it throws, and what must not be logged. */
const REVEALING = "no apartment for anna.andersson@exempel.se (19850101-1234)";

function seal(module: DynamicModule) {
  return sealPluginModule(module, OPTIONS);
}

function capabilitiesOf(controller: object): unknown {
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, controller) as unknown;
}

function pathOf(controller: object): unknown {
  return Reflect.getMetadata(PATH_METADATA, controller) as unknown;
}

/** The handler function itself, which is what the metadata sits on. */
function handlerOf(controller: { prototype: object }, name: string): object {
  return Object.getOwnPropertyDescriptor(controller.prototype, name)
    ?.value as object;
}

/**
 * The function the router would actually invoke for a method name.
 *
 * Resolved through the prototype chain, because that is how NestJS resolves
 * it: an inherited handler is the base class's function, and that function is
 * where its metadata lives.
 */
function resolvedHandlerOf(
  controller: { prototype: object },
  name: string,
): object {
  return (controller.prototype as Record<string, unknown>)[name] as object;
}

describe("sealing a plugin's module", () => {
  it("moves every controller under the plugin's own prefix", () => {
    @Controller("reports")
    class Reports {
      @Get("monthly")
      monthly(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, controllers: [Reports] });

    expect(result.ok).toBe(true);
    expect(pathOf(Reports)).toBe("api/plugin/occupancy/reports");
    // The handler's own path is untouched: it is relative to the controller,
    // which is now relative to the prefix.
    expect(
      Reflect.getMetadata(PATH_METADATA, handlerOf(Reports, "monthly")),
    ).toBe("monthly");
  });

  it("mounts a controller that declared no path on the prefix itself", () => {
    @Controller()
    class Root {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Root] }).ok).toBe(true);
    expect(pathOf(Root)).toBe("api/plugin/occupancy");
  });

  /**
   * The floor is what stops a plugin exposing the register to a caller the
   * core would refuse. It is merged into the controller's own list rather than
   * replacing it, because the guard reads the class's and the handler's
   * together: a route asking for more keeps what it asked for, and no route
   * can ask for less.
   */
  it("raises every controller to the plugin's capability floor", () => {
    @Controller("open")
    class Open {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    seal({ module: PluginModule, controllers: [Open] });

    expect(capabilitiesOf(Open)).toEqual(["addressBook:read"]);
  });

  it("keeps a capability a controller asked for on top of the floor", () => {
    @Controller("board")
    @RequireCapability("association:manage")
    class Board {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    seal({ module: PluginModule, controllers: [Board] });

    expect(capabilitiesOf(Board)).toEqual([
      "association:manage",
      "addressBook:read",
    ]);
  });

  /**
   * The one way a plugin could otherwise put a route outside the application's
   * authorization guard entirely. Overridden rather than deleted, because
   * deleting removes only a class's own metadata and a controller extending a
   * public base would keep the inherited opt-out.
   */
  it("overrides an attempt to make a plugin route public", () => {
    @Controller("leak")
    @Public()
    class Leak {
      @Get("all")
      @Public()
      all(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    seal({ module: PluginModule, controllers: [Leak] });

    expect(Reflect.getMetadata(IS_PUBLIC_ROUTE, Leak)).toBe(false);
    expect(Reflect.getMetadata(IS_PUBLIC_ROUTE, handlerOf(Leak, "all"))).toBe(
      false,
    );
  });

  /**
   * NestJS discovers route handlers across the whole prototype chain, so a
   * controller can serve a route it never declares. A seal that scanned only
   * own properties would leave that handler's `@Public()` in place, and the
   * authorization guard reads the handler's metadata before the class's - so
   * the opt-out on the inherited handler would win over the seal applied to
   * the controller, and the route would answer with no session at all.
   */
  it("overrides an inherited attempt to make a plugin route public", () => {
    class PublicBase {
      @Get("inherited")
      @Public()
      inherited(): string {
        return "";
      }
    }

    @Controller("derived")
    class Derived extends PublicBase {}

    @Module({})
    class PluginModule {}

    seal({ module: PluginModule, controllers: [Derived] });

    expect(
      Reflect.getMetadata(
        IS_PUBLIC_ROUTE,
        resolvedHandlerOf(Derived, "inherited"),
      ),
    ).toBe(false);
  });

  it("refuses an inherited handler whose path steps outside the prefix", () => {
    class EscapingBase {
      @Get("../../api/address-book")
      escape(): string {
        return "";
      }
    }

    @Controller("inherit-escape")
    class Inheriting extends EscapingBase {}

    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, controllers: [Inheriting] });

    expect(result.ok).toBe(false);
  });

  it("clears a host a controller scoped itself to", () => {
    @Controller({ path: "vhost", host: "admin.example.se" })
    class Vhost {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    seal({ module: PluginModule, controllers: [Vhost] });

    expect(Reflect.getMetadata(HOST_METADATA, Vhost)).toBeUndefined();
  });

  it("marks the controller with the plugin it came from", () => {
    @Controller("marked")
    class Marked {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    seal({ module: PluginModule, controllers: [Marked] });

    expect(Reflect.getMetadata(PLUGIN_ID_METADATA, Marked)).toBe("occupancy");
  });

  it("reaches a controller declared by a nested module", () => {
    @Controller("nested")
    class Nested {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({ controllers: [Nested] })
    class NestedModule {}
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, imports: [NestedModule] });

    expect(result.ok).toBe(true);
    expect(pathOf(Nested)).toBe("api/plugin/occupancy/nested");
    expect(capabilitiesOf(Nested)).toEqual(["addressBook:read"]);
  });

  it("reads a module class's own decorator as well as the dynamic object", () => {
    @Controller("declared")
    class Declared {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({ controllers: [Declared] })
    class PluginModule {}

    expect(seal({ module: PluginModule }).ok).toBe(true);
    expect(pathOf(Declared)).toBe("api/plugin/occupancy/declared");
  });

  it("refuses anything that is not a NestJS dynamic module", () => {
    for (const candidate of [undefined, null, {}, { routes: [] }, () => null]) {
      const result = sealPluginModule(candidate, OPTIONS);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toBe("module-invalid");
    }
  });

  describe("what a plugin may not register", () => {
    /**
     * An application-wide provider from a plugin would act on the core's own
     * routes: an interceptor could rewrite the register's responses, a filter
     * could swallow the application's errors, and a guard could refuse every
     * request on the instance.
     */
    it.each([
      ["APP_GUARD", APP_GUARD],
      ["APP_INTERCEPTOR", APP_INTERCEPTOR],
      ["APP_FILTER", APP_FILTER],
      ["APP_PIPE", APP_PIPE],
    ])("refuses a module providing %s", (_name, token) => {
      @Injectable()
      class Anything implements CanActivate {
        canActivate(): boolean {
          return true;
        }
      }
      @Module({})
      class PluginModule {}

      const result = seal({
        module: PluginModule,
        providers: [{ provide: token, useClass: Anything }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.log).toContain("application-wide");
    });

    it("refuses a global module", () => {
      @Global()
      @Module({})
      class GlobalPluginModule {}

      const result = seal({ module: GlobalPluginModule });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.log).toContain("global");
    });

    it("refuses a module that registers middleware", () => {
      @Module({})
      class MiddlewarePluginModule implements NestModule {
        configure(consumer: MiddlewareConsumer): void {
          void consumer;
        }
      }

      const result = seal({ module: MiddlewarePluginModule });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.log).toContain("middleware");
    });

    it("refuses an application-wide provider hidden in a nested module", () => {
      @Injectable()
      class Anything {}
      @Module({ providers: [{ provide: APP_GUARD, useClass: Anything }] })
      class NestedModule {}
      @Module({})
      class PluginModule {}

      expect(seal({ module: PluginModule, imports: [NestedModule] }).ok).toBe(
        false,
      );
    });

    it("refuses a path that steps outside the plugin's prefix", () => {
      @Controller("../../api/address-book")
      class Escape {
        @Get()
        index(): string {
          return "";
        }
      }
      @Module({})
      class PluginModule {}

      const result = seal({ module: PluginModule, controllers: [Escape] });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.log).toContain("steps outside");
    });

    it("refuses a route path that steps outside the plugin's prefix", () => {
      @Controller("fine")
      class Sneaky {
        @Post("../../../api/address-book/people")
        write(): string {
          return "";
        }
      }
      @Module({})
      class PluginModule {}

      expect(seal({ module: PluginModule, controllers: [Sneaky] }).ok).toBe(
        false,
      );
    });

    it("refuses a controller that is not decorated", () => {
      class Undecorated {}
      @Module({})
      class PluginModule {}

      expect(
        seal({ module: PluginModule, controllers: [Undecorated] }).ok,
      ).toBe(false);
    });

    it("refuses a controller that a second plugin also claims", () => {
      @Controller("shared")
      class Shared {
        @Get()
        index(): string {
          return "";
        }
      }
      @Module({})
      class First {}
      @Module({})
      class Second {}

      expect(seal({ module: First, controllers: [Shared] }).ok).toBe(true);
      expect(
        sealPluginModule(
          { module: Second, controllers: [Shared] },
          { pluginId: "other", floor: ["self:manage"], source: "" },
        ).ok,
      ).toBe(false);
    });

    it("refuses a module imported as a promise, which cannot be checked", () => {
      @Module({})
      class PluginModule {}

      const result = seal({
        module: PluginModule,
        imports: [Promise.resolve({ module: PluginModule })],
      });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.log).toContain("promise");
    });

    /**
     * A forward reference is a thunk the plugin wrote, so resolving it runs
     * the plugin's code and what it throws is the plugin's own text. The
     * refusal is written to the log, so it carries the class of the failure
     * and none of the message.
     */
    it("names the class when a forward reference throws, not its message", () => {
      @Module({})
      class PluginModule {}

      const result = seal({
        module: PluginModule,
        imports: [
          {
            forwardRef: () => {
              throw new TypeError(REVEALING);
            },
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.log).toContain("TypeError");
      expect(result.ok ? "" : result.log).not.toContain(REVEALING);
    });
  });

  /**
   * Sealing is the gate that decides whether a plugin runs at all, so nothing
   * in it may execute the plugin's code. An accessor has to be called to find
   * out what it holds, and NestJS routes to methods, so it is read from its
   * descriptor and left alone. Reading it would run plugin code inside the
   * gate and, when it throws, make one package's defect fatal to the boot of
   * the whole instance - which is the one thing ADR 0003 forbids, and which
   * this file's other assertions all assume cannot happen.
   */
  describe("a controller carrying an accessor", () => {
    function controllerWithThrowingGetter(): Type<object> {
      @Controller("reports")
      class ReportsController {
        @Get("summary")
        summary(): object {
          return {};
        }
      }
      Object.defineProperty(ReportsController.prototype, "trap", {
        configurable: true,
        get() {
          throw new Error(REVEALING);
        },
      });
      return ReportsController;
    }

    it("is sealed without the accessor being read", () => {
      @Module({})
      class PluginModule {}

      const result = seal({
        module: PluginModule,
        controllers: [controllerWithThrowingGetter()],
      });

      expect(result.ok).toBe(true);
      expect(result.ok ? result.controllers : []).toEqual([
        "api/plugin/occupancy/reports",
      ]);
    });

    it("has the methods beside it sealed all the same", () => {
      const controller = controllerWithThrowingGetter();
      @Module({})
      class PluginModule {}

      expect(seal({ module: PluginModule, controllers: [controller] }).ok).toBe(
        true,
      );

      // The walk reached the handler, so the accessor did not cut it short.
      expect(
        Reflect.getMetadata(IS_PUBLIC_ROUTE, handlerOf(controller, "summary")),
      ).toBe(false);
    });
  });
});

/**
 * The core services a plugin's provider may not be constructed with.
 *
 * Twelve of the platform's modules are global, so everything they export sits
 * in the root injector where any loaded plugin's constructor can ask for it.
 * Nothing above closes that: the global refusal stops a plugin EXPORTING
 * something everywhere, and the application-wide token check stops it acting on
 * the core's routes. This stops it IMPORTING what it was never given.
 */
describe("what a plugin's provider may be constructed with", () => {
  it("refuses one that asks for the audit log", () => {
    // The service that writes the append-only log. A plugin holding it could
    // record acts that did not happen and choose the channel they are recorded
    // under, which is the one field the audit change exists to make
    // unforgeable.
    class AuditLogService {}
    @Injectable()
    class Sneaky {
      constructor(private readonly audit: AuditLogService) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Sneaky] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("AuditLogService");
  });

  it("refuses one that asks for the action registry", () => {
    // Dispatch without the plugin's identity attached: a plugin holding it
    // could register actions as somebody else and invoke as anybody.
    class ActionRegistryService {}
    @Injectable()
    class Sneaky {
      constructor(private readonly registry: ActionRegistryService) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Sneaky] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
  });

  it("refuses a provider that asks for the service resolving a session", () => {
    /*
     * The connector's own route is Bearer-only, and the guard is what makes it
     * so. A plugin holding the service that resolves a person from request
     * headers could read the browser's cookie inside its own handler and
     * decide by it, which reaches around the one guarantee that route exists
     * to make - so it is refused where every other core service is.
     */
    class AuthService {}
    @Injectable()
    class Connector {
      constructor(private readonly auth: AuthService) {}
    }
    @Module({ providers: [Connector] })
    class PluginModule {}

    const result = sealPluginModule({ module: PluginModule }, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
  });

  it("refuses one reached through a nested module of its own", () => {
    // The graph is walked, so hiding the provider one import deeper does not
    // help.
    class PrincipalService {}
    @Injectable()
    class Sneaky {
      constructor(private readonly principals: PrincipalService) {}
    }
    @Module({ providers: [Sneaky] })
    class Inner {}
    @Module({ imports: [Inner] })
    class PluginModule {}

    const result = sealPluginModule({ module: PluginModule }, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
  });

  it("refuses one whose useClass asks for it, where the token is a string", () => {
    /*
     * The form that walked past a check reading `provide` alone. The token is a
     * string, so there is no constructor on it to read; what the container
     * builds is the useClass, and that is what has to be inspected. The three
     * modules these five live in are @Global(), so the plugin would have been
     * handed the real one.
     */
    class PrismaService {}
    @Injectable()
    class Sneaky {
      constructor(private readonly prisma: PrismaService) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      {
        module: PluginModule,
        providers: [{ provide: "PLUGIN_HELPER", useClass: Sneaky }],
      },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PrismaService");
  });

  it("refuses a factory that names it in inject", () => {
    // A factory's arguments are resolved exactly as a constructor's, and
    // nothing was reading the list that names them.
    class AuditLogService {}
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      {
        module: PluginModule,
        providers: [
          {
            provide: "REPORT",
            useFactory: (audit: unknown) => audit,
            inject: [AuditLogService],
          },
        ],
      },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("AuditLogService");
  });

  it("refuses an alias to it through useExisting", () => {
    // An alias resolves to what it names, so naming one is holding it.
    class PrincipalService {}
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      {
        module: PluginModule,
        providers: [{ provide: "WHO", useExisting: PrincipalService }],
      },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
  });

  it("refuses one that simply provides it", () => {
    // Declaring the class itself puts a working instance in the plugin's own
    // injector; reading only its constructor's own parameters said nothing.
    class PrismaService {}
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [PrismaService] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
  });

  it("refuses it behind a forwardRef in an inject array", () => {
    /*
     * `forwardRef(() => X)` is `{ forwardRef: thunk }`, and NestJS calls the
     * thunk when it resolves. A check that read the wrapper as an opaque object
     * would see no class at all, so the name it hides walks through - one
     * wrapper deep, in ordinary NestJS a plugin author would write without
     * thinking about it.
     */
    class PrismaService {}
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      {
        module: PluginModule,
        providers: [
          {
            provide: "DB",
            useFactory: (db: unknown) => db,
            inject: [forwardRef(() => PrismaService)],
          },
        ],
      },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PrismaService");
  });

  it("refuses it behind a forwardRef in constructor metadata", () => {
    // The other path: `@Inject(forwardRef(...))` writes the wrapper into
    // SELF_DECLARED_DEPS_METADATA rather than into design:paramtypes.
    class AuditLogService {}
    @Injectable()
    class Sneaky {
      constructor(
        @Inject(forwardRef(() => AuditLogService))
        private readonly audit: unknown,
      ) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Sneaky] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("AuditLogService");
  });

  it("refuses a forward reference whose thunk will not resolve", () => {
    // A reference the seal cannot follow is one whose target it cannot vouch
    // for, which is the same answer a module import that throws already gets.
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      {
        module: PluginModule,
        providers: [
          {
            provide: "WHAT",
            useFactory: (x: unknown) => x,
            inject: [
              {
                forwardRef: () => {
                  throw new Error("not yet");
                },
              },
            ],
          },
        ],
      },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
  });

  it("accepts a forwardRef to the plugin's own service", () => {
    // Circular references between a plugin's own providers are ordinary and
    // stay allowed: what is refused is the classified names, however they
    // arrive.
    class OwnHelper {}
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      {
        module: PluginModule,
        providers: [
          OwnHelper,
          {
            provide: "OWN",
            useFactory: (own: unknown) => own,
            inject: [forwardRef(() => OwnHelper)],
          },
        ],
      },
      OPTIONS,
    );

    expect(result.ok).toBe(true);
  });

  it("accepts a provider constructed with the plugin's own services", () => {
    class OwnHelper {}
    @Injectable()
    class Ordinary {
      constructor(private readonly helper: OwnHelper) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [OwnHelper, Ordinary] },
      OPTIONS,
    );

    expect(result.ok).toBe(true);
  });

  it("accepts the ordinary factory and alias forms over its own services", () => {
    // The forms above are not refused as forms: what is refused is the five
    // names, wherever a declaration puts them.
    class OwnHelper {}
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      {
        module: PluginModule,
        providers: [
          OwnHelper,
          { provide: "OWN", useExisting: OwnHelper },
          {
            provide: "REPORT",
            useFactory: (own: unknown) => own,
            inject: [OwnHelper],
          },
          { provide: "ALSO", useClass: OwnHelper },
        ],
      },
      OPTIONS,
    );

    expect(result.ok).toBe(true);
  });

  it("refuses one that takes it as an injected field", () => {
    // NestJS assigns `@Inject()` fields after construction, from the same
    // injector, so the field is as much a reach as a constructor parameter.
    class PrismaService {}
    @Injectable()
    class Sneaky {
      @Inject(PrismaService) private readonly db!: PrismaService;
    }
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    const result = sealPluginModule({ module: PluginModule }, OPTIONS);

    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PrismaService");
  });

  it("refuses one that provides a renamed subclass of it", () => {
    // A subclass is constructed as its base is, under a name the denylist
    // never wrote down.
    class PrismaService {}
    @Injectable()
    class Database extends PrismaService {}
    @Module({ providers: [Database] })
    class PluginModule {}

    const result = sealPluginModule({ module: PluginModule }, OPTIONS);

    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
  });
});

/**
 * A controller is built by the same injector as a provider, and so is every
 * guard, interceptor, pipe and filter it names by class.
 */
describe("what a plugin's controller may be constructed with", () => {
  function sealed(controller: Type) {
    @Module({ controllers: [controller] })
    class PluginModule {}
    return sealPluginModule({ module: PluginModule }, OPTIONS);
  }

  it("refuses one that asks for the database in its constructor", () => {
    class PrismaService {}
    @Controller("rooms")
    class Rooms {
      constructor(private readonly db: PrismaService) {}
    }

    const result = sealed(Rooms);

    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PrismaService");
  });

  it("refuses one that takes the injector handle as a field", () => {
    class ModuleRef {}
    @Controller("rooms")
    class Rooms {
      @Inject(ModuleRef) private readonly modules!: ModuleRef;
    }

    expect(sealed(Rooms)).toMatchObject({ reason: "forbidden-injection" });
  });

  it("refuses a guard it names that asks for the audit log", () => {
    class AuditLogService {}
    @Injectable()
    class SneakyGuard implements CanActivate {
      constructor(private readonly audit: AuditLogService) {}
      canActivate() {
        return true;
      }
    }
    @Controller("rooms")
    @UseGuards(SneakyGuard)
    class Rooms {}

    expect(sealed(Rooms)).toMatchObject({ reason: "forbidden-injection" });
  });

  it("refuses an interceptor named on one route", () => {
    class MailService {}
    @Injectable()
    class SneakyInterceptor {
      @Inject(MailService) private readonly mail!: MailService;
      intercept() {
        return undefined;
      }
    }
    @Controller("rooms")
    class Rooms {
      @Get()
      @UseInterceptors(SneakyInterceptor)
      list() {
        return [];
      }
    }

    expect(sealed(Rooms)).toMatchObject({ reason: "forbidden-injection" });
  });

  it("refuses a pipe given to one parameter", () => {
    class FieldEncryptionService {}
    @Injectable()
    class SneakyPipe {
      constructor(private readonly fields: FieldEncryptionService) {}
      transform(value: unknown) {
        return value;
      }
    }
    @Controller("rooms")
    class Rooms {
      @Post()
      create(@Body(SneakyPipe) body: unknown) {
        return body;
      }
    }

    expect(sealed(Rooms)).toMatchObject({ reason: "forbidden-injection" });
  });

  it("looks at the token a parameter is injected as, not the type it is declared with", () => {
    // NestJS hands this controller "plugin-local"; PrismaService is only the
    // annotation, so the plugin is not asking for the database.
    class PrismaService {}
    @Controller("rooms")
    class Rooms {
      constructor(
        @Inject("plugin-local") private readonly local: PrismaService,
      ) {}
    }

    expect(sealed(Rooms).ok).toBe(true);
  });

  it("still refuses a parameter whose explicit token is forbidden", () => {
    class PrismaService {}
    @Controller("rooms")
    class Rooms {
      constructor(
        @Inject(PrismaService) private readonly db: { local: string },
      ) {}
    }

    expect(sealed(Rooms)).toMatchObject({ reason: "forbidden-injection" });
  });

  it("accepts one built from the plugin's own services and enhancers", () => {
    class OwnHelper {}
    class OwnPipe {
      transform(value: unknown) {
        return value;
      }
    }
    @Injectable()
    class OwnGuard implements CanActivate {
      constructor(private readonly helper: OwnHelper) {}
      canActivate() {
        return true;
      }
    }
    @Controller("rooms")
    @UseGuards(OwnGuard)
    class Rooms {
      constructor(private readonly helper: OwnHelper) {}
      @Get()
      @UsePipes(new OwnPipe())
      list() {
        return [];
      }
    }

    expect(sealed(Rooms).ok).toBe(true);
  });
});

/**
 * NestJS registers every module class as a provider of its own module and
 * builds it from the same injector, so the class a plugin hands over is
 * constructed with whatever it asks for.
 */
describe("what a plugin's module class may be constructed with", () => {
  it("refuses one whose constructor asks for the database", () => {
    class PrismaService {}
    @Module({})
    class PluginModule {
      constructor(private readonly db: PrismaService) {}
    }

    const result = seal({ module: PluginModule });

    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PrismaService");
  });

  it("refuses one that takes the configuration as an injected field", () => {
    const ENV = Symbol("OPENBRF_ENV");
    @Module({})
    class PluginModule {
      @Inject(ENV) private readonly env!: unknown;
    }

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses one reached through a nested module of its own", () => {
    class AuditLogService {}
    @Module({})
    class Inner {
      constructor(private readonly audit: AuditLogService) {}
    }
    @Module({ imports: [Inner] })
    class PluginModule {}

    const result = seal({ module: PluginModule });

    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("Inner");
  });

  it("accepts one constructed with the plugin's own services", () => {
    class OwnHelper {}
    @Module({ providers: [OwnHelper] })
    class PluginModule {
      constructor(private readonly helper: OwnHelper) {}
    }

    expect(seal({ module: PluginModule }).ok).toBe(true);
  });
});

/**
 * NestJS builds the guards, interceptors, pipes and filters a provider names
 * exactly as it builds a controller's, whether or not the provider serves a
 * route.
 */
describe("what a plugin's provider may name as an enhancer", () => {
  function sealed(provider: Type) {
    @Module({ providers: [provider] })
    class PluginModule {}
    return seal({ module: PluginModule });
  }

  it("refuses a guard named on the class that asks for the database", () => {
    class PrismaService {}
    @Injectable()
    class SneakyGuard implements CanActivate {
      constructor(private readonly db: PrismaService) {}
      canActivate() {
        return true;
      }
    }
    @Injectable()
    @UseGuards(SneakyGuard)
    class Helper {}

    const result = sealed(Helper);

    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PrismaService");
  });

  it("refuses an interceptor named on one method", () => {
    class MailService {}
    @Injectable()
    class SneakyInterceptor {
      constructor(private readonly mail: MailService) {}
      intercept() {
        return undefined;
      }
    }
    @Injectable()
    class Helper {
      @UseInterceptors(SneakyInterceptor)
      run() {
        return undefined;
      }
    }

    expect(sealed(Helper)).toMatchObject({ reason: "forbidden-injection" });
  });

  it("refuses a pipe given to one parameter", () => {
    class FieldEncryptionService {}
    @Injectable()
    class SneakyPipe {
      constructor(private readonly fields: FieldEncryptionService) {}
      transform(value: unknown) {
        return value;
      }
    }
    @Injectable()
    class Helper {
      run(@Body(SneakyPipe) body: unknown) {
        return body;
      }
    }

    expect(sealed(Helper)).toMatchObject({ reason: "forbidden-injection" });
  });

  it("refuses one named by the class a string token is built as", () => {
    class AuditLogService {}
    @Injectable()
    class SneakyGuard implements CanActivate {
      constructor(private readonly audit: AuditLogService) {}
      canActivate() {
        return true;
      }
    }
    @Injectable()
    @UseGuards(SneakyGuard)
    class Helper {}
    @Module({})
    class PluginModule {}

    expect(
      seal({
        module: PluginModule,
        providers: [{ provide: "HELPER", useClass: Helper }],
      }),
    ).toMatchObject({ reason: "forbidden-injection" });
  });

  it("refuses an enhancer the module class itself names", () => {
    class PrismaService {}
    @Injectable()
    class SneakyGuard implements CanActivate {
      constructor(private readonly db: PrismaService) {}
      canActivate() {
        return true;
      }
    }
    @Module({})
    @UseGuards(SneakyGuard)
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("accepts a provider naming the plugin's own enhancers", () => {
    class OwnHelper {}
    @Injectable()
    class OwnGuard implements CanActivate {
      constructor(private readonly helper: OwnHelper) {}
      canActivate() {
        return true;
      }
    }
    @Injectable()
    @UseGuards(OwnGuard)
    class Helper {}
    @Module({ providers: [OwnHelper, Helper] })
    class PluginModule {}

    expect(seal({ module: PluginModule }).ok).toBe(true);
  });
});

/**
 * Metadata written by hand rather than by a decorator, read as NestJS reads it.
 *
 * A decorator always writes a numeric index and an array, but nothing makes a
 * plugin use one, and NestJS does not check either: it assigns
 * `parameters[index] = param` and iterates whatever list it is given.
 */
describe("injection metadata in the shapes NestJS also accepts", () => {
  it("refuses a self-declared parameter whose index is a string", () => {
    // `parameters["0"]` is `parameters[0]`, so NestJS hands this class the
    // database in place of the declared OwnHelper.
    class OwnHelper {}
    class PrismaService {}
    @Injectable()
    class Sneaky {
      constructor(private readonly helper: OwnHelper) {}
    }
    Reflect.defineMetadata(
      SELF_DECLARED_DEPS_METADATA,
      [{ index: "0", param: PrismaService }],
      Sneaky,
    );
    @Module({ providers: [OwnHelper, Sneaky] })
    class PluginModule {}

    const result = seal({ module: PluginModule });

    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PrismaService");
  });

  it("reads the token a string index replaces a design type with", () => {
    // The same assignment in the other direction: the database is only the
    // annotation, and NestJS hands this class "plugin-local".
    class PrismaService {}
    @Injectable()
    class Ordinary {
      constructor(private readonly local: PrismaService) {}
    }
    Reflect.defineMetadata(
      SELF_DECLARED_DEPS_METADATA,
      [{ index: "0", param: "plugin-local" }],
      Ordinary,
    );
    @Module({ providers: [Ordinary] })
    class PluginModule {}

    expect(seal({ module: PluginModule }).ok).toBe(true);
  });

  it("refuses a self-declared parameter past the declared ones", () => {
    // Writing past the end stretches the array for NestJS, so the parameter
    // is resolved like any other.
    class AuditLogService {}
    @Injectable()
    class Sneaky {}
    Reflect.defineMetadata(
      SELF_DECLARED_DEPS_METADATA,
      [{ index: 3, param: AuditLogService }],
      Sneaky,
    );
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses an index that is an object, whose position its own code decides", () => {
    @Injectable()
    class Sneaky {}
    Reflect.defineMetadata(
      SELF_DECLARED_DEPS_METADATA,
      [{ index: { toString: () => "0" }, param: "plugin-local" }],
      Sneaky,
    );
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses constructor metadata given as a set rather than an array", () => {
    // NestJS spreads it and resolves what the set holds. The entry over
    // parameter 0 leaves NestJS still resolving parameter 1, the database.
    class OwnHelper {}
    class PrismaService {}
    @Injectable()
    class Sneaky {}
    Reflect.defineMetadata(
      "design:paramtypes",
      new Set([OwnHelper, PrismaService]),
      Sneaky,
    );
    Reflect.defineMetadata(
      SELF_DECLARED_DEPS_METADATA,
      [{ index: 0, param: "plugin-local" }],
      Sneaky,
    );
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a parameter pipe given as one class rather than a list", () => {
    // NestJS flattens a parameter's pipes one level, so a single class is
    // built as surely as a list holding it.
    class FieldEncryptionService {}
    @Injectable()
    class SneakyPipe {
      constructor(private readonly fields: FieldEncryptionService) {}
      transform(value: unknown) {
        return value;
      }
    }
    @Controller("rooms")
    class Rooms {
      @Post()
      create() {
        return undefined;
      }
    }
    Reflect.defineMetadata(
      ROUTE_ARGS_METADATA,
      { "3:0": { index: 0, pipes: SneakyPipe } },
      Rooms,
      "create",
    );
    @Module({ controllers: [Rooms] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a design type at a position its array does not list", () => {
    class PrismaService {}
    @Injectable()
    class Sneaky {}
    const designed: unknown[] = [];
    Object.defineProperty(designed, 0, {
      value: PrismaService,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Reflect.defineMetadata("design:paramtypes", designed, Sneaky);
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    // NestJS walks the array to its length, listed or not.
    expect(new Injector().reflectConstructorParams(Sneaky)).toEqual([
      PrismaService,
    ]);
    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  /**
   * NestJS destructures each dependency record, and a function carries fields
   * as well as an object does.
   */
  describe("a dependency record given as a function", () => {
    class PrismaService {}

    function record(fields: Record<string, unknown>): () => void {
      return Object.assign(function dependency() {}, fields);
    }

    it("is read as a self-declared parameter", () => {
      @Injectable()
      class Sneaky {}
      Reflect.defineMetadata(
        SELF_DECLARED_DEPS_METADATA,
        [record({ index: 0, param: PrismaService })],
        Sneaky,
      );
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(new Injector().reflectConstructorParams(Sneaky)).toEqual([
        PrismaService,
      ]);
      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("is read as an injected field", () => {
      @Injectable()
      class Sneaky {}
      Reflect.defineMetadata(
        PROPERTY_DEPS_METADATA,
        [record({ key: "db", type: PrismaService })],
        Sneaky,
      );
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(new Injector().reflectProperties(Sneaky)).toMatchObject([
        { key: "db", name: PrismaService },
      ]);
      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("is read as a route parameter's pipes", () => {
      @Injectable()
      class SneakyPipe {
        constructor(private readonly db: PrismaService) {}
        transform(value: unknown) {
          return value;
        }
      }
      @Controller("rooms")
      class Rooms {
        @Post()
        create() {
          return undefined;
        }
      }
      Reflect.defineMetadata(
        ROUTE_ARGS_METADATA,
        { "3:0": record({ index: 0, pipes: [SneakyPipe] }) },
        Rooms,
        "create",
      );
      @Module({ controllers: [Rooms] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });
  });

  it("reads a design type at the last position an array can hold", () => {
    // Read from the array's keys: counting up to a length of four billion
    // would hold the boot.
    class PrismaService {}
    @Injectable()
    class Sneaky {}
    const designed: unknown[] = [];
    designed[2 ** 32 - 2] = PrismaService;
    Reflect.defineMetadata("design:paramtypes", designed, Sneaky);
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a metadata list that brings its own iterator", () => {
    // NestJS assigns self-declared entries with forEach, which never asks
    // the list for an iterator.
    class PrismaService {}
    @Injectable()
    class Sneaky {}
    const entries = [{ index: 0, param: PrismaService }];
    Object.defineProperty(entries, Symbol.iterator, {
      value: function* () {},
    });
    Reflect.defineMetadata(SELF_DECLARED_DEPS_METADATA, entries, Sneaky);
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a metadata list that reads a position through a getter", () => {
    class OwnHelper {}
    @Injectable()
    class Sneaky {}
    const designed: unknown[] = [];
    Object.defineProperty(designed, 0, {
      get: () => OwnHelper,
      enumerable: true,
    });
    Reflect.defineMetadata("design:paramtypes", designed, Sneaky);
    @Module({ providers: [OwnHelper, Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a module whose providers are a set rather than an array", () => {
    // NestJS spreads the list and registers what the set holds.
    class PrismaService {}
    @Injectable()
    class Sneaky {
      constructor(private readonly db: PrismaService) {}
    }
    class PluginModule {}
    Reflect.defineMetadata("providers", new Set([Sneaky]), PluginModule);

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
    expect(
      seal({ module: class Dynamic {}, providers: new Set([Sneaky]) } as never),
    ).toMatchObject({ reason: "module-refused" });
  });

  it("refuses a factory whose arguments are a set rather than an array", () => {
    // NestJS reads `inject` with Array.from and resolves what the set holds.
    class PrismaService {}
    @Module({
      providers: [
        {
          provide: "plugin-local",
          useFactory: (db: PrismaService) => db,
          inject: new Set([PrismaService]) as never,
        },
      ],
    })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses parameter pipes given as a proxy", () => {
    class FieldEncryptionService {}
    @Injectable()
    class SneakyPipe {
      constructor(private readonly fields: FieldEncryptionService) {}
      transform(value: unknown) {
        return value;
      }
    }
    @Controller("rooms")
    class Rooms {
      @Post()
      create() {
        return undefined;
      }
    }
    Reflect.defineMetadata(
      ROUTE_ARGS_METADATA,
      { "3:0": { index: 0, pipes: new Proxy([SneakyPipe], {}) } },
      Rooms,
      "create",
    );
    @Module({ controllers: [Rooms] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a module whose controllers are a set rather than an array", () => {
    // Read as empty, the controller would be mounted unsealed: at its own
    // path, with no capability floor and its opt-out of the guard intact.
    @Controller("anywhere")
    class Unsealed {}
    @Module({})
    class PluginModule {}

    expect(
      seal({ module: PluginModule, controllers: new Set([Unsealed]) } as never),
    ).toMatchObject({ reason: "module-refused" });
    expect(pathOf(Unsealed)).toBe("anywhere");
  });

  it("refuses a module whose imports are a set rather than an array", () => {
    @Global()
    @Module({})
    class Everywhere {}
    class PluginModule {}
    Reflect.defineMetadata("imports", new Set([Everywhere]), PluginModule);

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("refuses a factory argument whose wrapper resolves elsewhere than its token", () => {
    // Without `optional`, NestJS resolves the wrapper rather than its token,
    // and the wrapper's forward reference is what it is handed.
    class OwnHelper {}
    class ModulesContainer {}
    const argument = { token: OwnHelper, forwardRef: () => ModulesContainer };
    const injector = new Injector();
    const [[dependency]] = injector.getFactoryProviderDependencies({
      inject: [argument],
    } as never);
    expect(injector.resolveParamToken({} as never, dependency as never)).toBe(
      ModulesContainer,
    );

    @Module({
      providers: [
        OwnHelper,
        {
          provide: "plugin-local",
          useFactory: (modules: ModulesContainer) => modules,
          inject: [argument as never],
        },
      ],
    })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a provider object with a prototype, whose enhancers NestJS builds", () => {
    class ModulesContainer {}
    @Injectable()
    class Sneaky implements CanActivate {
      constructor(private readonly modules: ModulesContainer) {}
      canActivate(): boolean {
        return true;
      }
    }
    const provider = { provide: "plugin-local", useValue: 1, prototype: {} };
    Reflect.defineMetadata(GUARDS_METADATA, [Sneaky], provider);
    @Module({ providers: [provider] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("refuses a self-declared index that replaces the parameters' prototype", () => {
    class ModulesContainer {}
    @Injectable()
    class Sneaky {}
    Reflect.defineMetadata(
      SELF_DECLARED_DEPS_METADATA,
      [
        {
          index: "__proto__",
          param: {
            *[Symbol.iterator]() {
              yield ModulesContainer;
            },
          },
        },
      ],
      Sneaky,
    );
    @Module({ providers: [Sneaky] })
    class PluginModule {}

    // NestJS copies the array through the iterator the new prototype gave it.
    expect(new Injector().reflectConstructorParams(Sneaky)).toEqual([
      ModulesContainer,
    ]);
    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("refuses a self-declared index that names the length", () => {
    // Assigning a class to `length` throws, in NestJS and in the seal alike.
    class OwnHelper {}
    @Injectable()
    class Sneaky {}
    Reflect.defineMetadata(
      SELF_DECLARED_DEPS_METADATA,
      [{ index: "length", param: OwnHelper }],
      Sneaky,
    );
    @Module({ providers: [OwnHelper, Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({ ok: false });
  });

  /**
   * NestJS and the seal walk these lists with different calls - spread,
   * `forEach`, `map`, `for...of` - so a list that answers one of them itself
   * could tell each side something else.
   */
  describe("a metadata list that brings its own way of being read", () => {
    class ModulesContainer {}
    class OwnHelper {}

    function own<List extends unknown[]>(
      list: List,
      key: PropertyKey,
      value: unknown,
    ): List {
      Object.defineProperty(list, key, { value });
      return list;
    }

    it("is refused as constructor parameters with their own iterator", () => {
      @Injectable()
      class Sneaky {}
      Reflect.defineMetadata(
        "design:paramtypes",
        own([OwnHelper], Symbol.iterator, function* () {
          yield ModulesContainer;
        }),
        Sneaky,
      );
      @Module({ providers: [OwnHelper, Sneaky] })
      class PluginModule {}

      expect(new Injector().reflectConstructorParams(Sneaky)).toEqual([
        ModulesContainer,
      ]);
      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("is refused as self-declared parameters with their own forEach", () => {
      @Injectable()
      class Sneaky {}
      Reflect.defineMetadata(
        SELF_DECLARED_DEPS_METADATA,
        own([], "forEach", (assign: (entry: object) => void) => {
          assign({ index: 0, param: ModulesContainer });
        }),
        Sneaky,
      );
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(new Injector().reflectConstructorParams(Sneaky)).toEqual([
        ModulesContainer,
      ]);
      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("is refused as injected fields with their own map", () => {
      // A map that keeps only what the seal's callback would not make a
      // function of, which is everything NestJS's callback makes.
      @Injectable()
      class Sneaky {}
      const fields = own(
        [{ key: "modules", type: ModulesContainer }],
        "map",
        function (
          this: unknown[],
          callback: (entry: unknown, index: number) => unknown,
        ) {
          return Array.prototype.map
            .call(this, callback)
            .filter((entry) => typeof entry !== "function");
        },
      );
      Reflect.defineMetadata(PROPERTY_DEPS_METADATA, fields, Sneaky);
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(new Injector().reflectProperties(Sneaky)).toMatchObject([
        { name: ModulesContainer },
      ]);
      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("is refused as class guards with their own forEach", () => {
      @Injectable()
      class Sneaky implements CanActivate {
        constructor(private readonly modules: ModulesContainer) {}
        canActivate(): boolean {
          return true;
        }
      }
      @Injectable()
      class Ordinary {}
      Reflect.defineMetadata(
        GUARDS_METADATA,
        own([], "forEach", (insert: (guard: unknown) => void) => {
          insert(Sneaky);
        }),
        Ordinary,
      );
      @Module({ providers: [Ordinary] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });
  });
});

describe("a module global by any other value", () => {
  // NestJS treats any truthy value as global, from either place.
  it("is refused from the dynamic object", () => {
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, global: 1 } as never)).toMatchObject({
      reason: "module-refused",
    });
  });

  it("is refused from the class's metadata", () => {
    @Module({})
    class PluginModule {}
    Reflect.defineMetadata(GLOBAL_MODULE_METADATA, "yes", PluginModule);

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });
});

/**
 * A function read the way NestJS reads it, which is by its fields.
 *
 * NestJS asks a provider for `provide`, a module for `module`, `forwardRef` and
 * `then`, and a class for the methods on its prototype, without first asking
 * whether the value is a class or an object. The seal asks the same questions.
 */
describe("a class NestJS reads by its fields", () => {
  it("is refused as a provider with a static application-wide token", () => {
    @Injectable()
    class Anything {}
    class Declared {
      static provide = APP_GUARD;
      static useClass = Anything;
    }
    @Module({ providers: [Declared] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("is refused as a provider with a static factory", () => {
    class ModulesContainer {}
    class Declared {
      static provide = "plugin-local";
      static useFactory = (held: unknown) => held;
      static inject = [ModulesContainer];
    }
    @Module({ providers: [Declared] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("is refused as an enhancer with a static factory", () => {
    class ModulesContainer {}
    class Declared {
      static provide = "plugin-local";
      static useFactory = (held: unknown) => held;
      static inject = [ModulesContainer];
    }
    @Injectable()
    @UseGuards(Declared)
    class Helper {}
    @Module({ providers: [Helper] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("has the enhancers on a prototype that is a function read", () => {
    class PrismaService {}
    class Guard {}
    Reflect.defineMetadata("design:paramtypes", [PrismaService], Guard);
    function handler() {}
    Reflect.defineMetadata(GUARDS_METADATA, [Guard], handler);
    function Provider() {}
    Provider.prototype = Object.assign(function methods() {}, { handler });
    @Module({ providers: [Provider as never] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("has the routes on a prototype that is a function sealed", () => {
    function open() {}
    Reflect.defineMetadata(PATH_METADATA, "open", open);
    Reflect.defineMetadata(IS_PUBLIC_ROUTE, true, open);
    // A function rather than a class, whose prototype cannot be replaced.
    function Callable() {}
    Callable.prototype = Object.assign(function methods() {}, {
      open,
      constructor: Callable,
    });
    Controller("callable")(Callable);
    @Module({})
    class PluginModule {}

    expect(
      seal({ module: PluginModule, controllers: [Callable as never] }).ok,
    ).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_ROUTE, open)).toBe(false);
  });

  it("is refused as an import with a static then", () => {
    class Promised {
      // oxlint-disable-next-line unicorn/no-thenable -- the shape under test
      static then(resolve: (module: unknown) => void) {
        resolve({ module: Promised });
      }
    }
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, imports: [Promised] })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("is refused as a forward reference that resolves to a promise", () => {
    @Module({})
    class Harmless {}
    @Module({})
    class PluginModule {}

    expect(
      seal({
        module: PluginModule,
        imports: [
          forwardRef(() => ({
            module: Harmless,
            // oxlint-disable-next-line unicorn/no-thenable -- the shape under test
            then: () => undefined,
          })),
        ],
      }),
    ).toMatchObject({ reason: "module-refused" });
  });

  it("is followed as an import with a static forwardRef", () => {
    @Global()
    @Module({})
    class Everywhere {}
    class Referring {
      static forwardRef = () => Everywhere;
    }
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, imports: [Referring] });

    expect(result.ok ? "" : result.log).toContain("global");
  });

  it("is refused as a forward reference to another forward reference", () => {
    @Module({})
    class Harmless {}
    class Referring {
      static forwardRef = () => Harmless;
    }
    @Module({})
    class PluginModule {}

    expect(
      seal({ module: PluginModule, imports: [forwardRef(() => Referring)] }),
    ).toMatchObject({ reason: "module-refused" });
  });

  it("is read as a dynamic module when it has a static module", () => {
    @Module({})
    class Harmless {}
    class Described {
      static module = Harmless;
      static global = true;
    }
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, imports: [Described] });

    expect(result.ok ? "" : result.log).toContain("global");
  });

  it("is refused as an import with a static forwardRef and module", () => {
    @Module({})
    class Harmless {}
    @Module({})
    class Elsewhere {}
    @Controller("api/elsewhere")
    class Unsealed {}
    class Both {
      static forwardRef = () => Harmless;
      static module = Elsewhere;
      static controllers = [Unsealed];
    }
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, imports: [Both] })).toMatchObject({
      reason: "module-refused",
    });
  });
});

/**
 * NestJS follows the `forwardRef` of an import when it scans the graph, but
 * registers a dynamic module's imports by their `module` first, so an entry
 * with both would be registered as each and checked as only one.
 */
describe("a module that is also a forward reference", () => {
  it("is refused as the plugin's module", () => {
    @Module({})
    class Harmless {}
    @Module({})
    class PluginModule {}

    expect(
      seal({
        module: PluginModule,
        global: true,
        forwardRef: () => Harmless,
      } as DynamicModule),
    ).toMatchObject({ reason: "module-refused" });
  });

  it("is refused as an import", () => {
    @Injectable()
    class Anything {}
    @Module({})
    class Harmless {}
    @Module({})
    class Elsewhere {}
    @Module({})
    class PluginModule {}

    expect(
      seal({
        module: PluginModule,
        imports: [
          {
            module: Elsewhere,
            providers: [{ provide: APP_GUARD, useClass: Anything }],
            forwardRef: () => Harmless,
          } as DynamicModule,
        ],
      }),
    ).toMatchObject({ reason: "module-refused" });
  });
});

/**
 * NestJS routes every handler that has a path, with or without a request
 * method, so the seal treats every such handler as a route.
 */
describe("a handler with a path and no request method", () => {
  it("has its opt-out of authorization overridden", () => {
    @Controller("quiet")
    class Quiet {
      @SetMetadata(PATH_METADATA, "x")
      @Public()
      handle(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Quiet] }).ok).toBe(true);
    expect(
      Reflect.getMetadata(IS_PUBLIC_ROUTE, handlerOf(Quiet, "handle")),
    ).toBe(false);
  });

  it("is refused when its path steps outside the prefix", () => {
    @Controller("quiet")
    class Quiet {
      @SetMetadata(PATH_METADATA, "../../api/address-book")
      handle(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Quiet] })).toMatchObject({
      reason: "module-refused",
    });
  });
});

/**
 * Reading a plugin's module runs the plugin's code, and the seal promises a
 * refusal rather than an exception or a boot that never finishes.
 */
describe("a module the seal cannot finish reading", () => {
  it("is refused when a class's name throws, without what it threw", () => {
    @Injectable()
    class Throwing {}
    Object.defineProperty(Throwing, "name", {
      get() {
        throw new Error(REVEALING);
      },
    });
    @Module({ providers: [Throwing] })
    class PluginModule {}

    const result = seal({ module: PluginModule });

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).not.toContain("anna");
  });

  it("is refused when a token's prototype chain never ends", () => {
    const endless = (): object =>
      new Proxy(function () {}, { getPrototypeOf: () => endless() });
    @Module({
      providers: [{ provide: "plugin-local", useExisting: endless() }],
    })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("is refused when a class's methods sit on a chain that never ends", () => {
    const endless = (): object =>
      new Proxy({}, { getPrototypeOf: () => endless() });
    function Provider() {}
    Provider.prototype = endless();
    @Module({ providers: [Provider as never] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });
});

/** Makes `key` a getter on `target` that always answers `value`. */
function withGetter<Target extends object>(
  target: Target,
  key: PropertyKey,
  value: unknown,
): Target {
  Object.defineProperty(target, key, {
    get: () => value,
    enumerable: true,
    configurable: true,
  });
  return target;
}

/**
 * NestJS reads every field the seal reads again, often more than once, and a
 * getter or a proxy answers each read afresh. So one is refused whatever it
 * answers: each one here gives the seal a harmless answer, which it used to
 * accept.
 */
describe("a field the seal reads, kept behind a getter or a proxy", () => {
  @Injectable()
  class OwnHelper {}

  describe("in a class's constructor and fields", () => {
    class PrismaService {}

    it("refuses a self-declared parameter whose token is a getter", () => {
      class ModulesContainer {}
      @Injectable()
      class Sneaky {}
      let reads = 0;
      Reflect.defineMetadata(
        SELF_DECLARED_DEPS_METADATA,
        [
          {
            index: 0,
            get param() {
              reads += 1;
              return reads === 1 ? "plugin-local" : ModulesContainer;
            },
          },
        ],
        Sneaky,
      );
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
      // NestJS reads the entry on every build, and is told something else.
      expect(new Injector().reflectConstructorParams(Sneaky)).toEqual([
        "plugin-local",
      ]);
      expect(new Injector().reflectConstructorParams(Sneaky)).toEqual([
        ModulesContainer,
      ]);
    });

    it("refuses a self-declared parameter whose index is a getter", () => {
      @Injectable()
      class Sneaky {
        constructor(readonly db: PrismaService) {}
      }
      Reflect.defineMetadata(
        SELF_DECLARED_DEPS_METADATA,
        [withGetter({ param: "plugin-local" }, "index", 0)],
        Sneaky,
      );
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("refuses a self-declared parameter that is a proxy", () => {
      @Injectable()
      class Sneaky {
        constructor(readonly db: PrismaService) {}
      }
      Reflect.defineMetadata(
        SELF_DECLARED_DEPS_METADATA,
        [new Proxy({ index: 0, param: "plugin-local" }, {})],
        Sneaky,
      );
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("refuses a self-declared parameter that inherits its token through a proxy", () => {
      @Injectable()
      class Sneaky {
        constructor(readonly db: PrismaService) {}
      }
      const entry = Object.assign(
        Object.create(new Proxy({ param: "plugin-local" }, {})) as object,
        { index: 0 },
      );
      Reflect.defineMetadata(SELF_DECLARED_DEPS_METADATA, [entry], Sneaky);
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("refuses an injected field whose type is a getter", () => {
      @Injectable()
      class Sneaky {}
      Reflect.defineMetadata(
        PROPERTY_DEPS_METADATA,
        [withGetter({ key: "helper" }, "type", OwnHelper)],
        Sneaky,
      );
      @Module({ providers: [OwnHelper, Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });
  });

  describe("in a route's parameters", () => {
    function sealWithParameters(parameters: object) {
      @Controller("rooms")
      class Rooms {
        @Post()
        create() {
          return undefined;
        }
      }
      Reflect.defineMetadata(ROUTE_ARGS_METADATA, parameters, Rooms, "create");
      @Module({ controllers: [Rooms] })
      class PluginModule {}
      return sealPluginModule({ module: PluginModule }, OPTIONS);
    }

    it("refuses a parameter whose pipes are a getter", () => {
      expect(
        sealWithParameters({ "3:0": withGetter({ index: 0 }, "pipes", []) }),
      ).toMatchObject({ reason: "forbidden-injection" });
    });

    it("refuses parameters one of which is a getter", () => {
      expect(
        sealWithParameters(withGetter({}, "3:0", { index: 0, pipes: [] })),
      ).toMatchObject({ reason: "forbidden-injection" });
    });
  });

  describe("in a provider's declaration", () => {
    it("refuses a provide that is a getter", () => {
      @Module({
        providers: [
          withGetter({ useValue: 1 }, "provide", "plugin-local") as never,
        ],
      })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "module-refused",
      });
    });

    it("refuses a useClass that is a getter", () => {
      @Module({
        providers: [
          withGetter(
            { provide: "plugin-local" },
            "useClass",
            OwnHelper,
          ) as never,
        ],
      })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("refuses a useExisting that is a getter", () => {
      @Module({
        providers: [
          OwnHelper,
          withGetter(
            { provide: "plugin-local" },
            "useExisting",
            OwnHelper,
          ) as never,
        ],
      })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("refuses an inject that is a getter", () => {
      @Module({
        providers: [
          withGetter(
            { provide: "plugin-local", useFactory: () => 1 },
            "inject",
            [],
          ),
        ],
      })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("refuses a factory argument whose token is a getter", () => {
      @Module({
        providers: [
          OwnHelper,
          {
            provide: "plugin-local",
            useFactory: (helper: OwnHelper) => helper,
            inject: [
              withGetter({ optional: true }, "token", OwnHelper) as never,
            ],
          },
        ],
      })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });

    it("refuses a provider object whose prototype is a getter", () => {
      @Module({
        providers: [
          withGetter(
            { provide: "plugin-local", useValue: 1 },
            "prototype",
            undefined,
          ),
        ],
      })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "module-refused",
      });
    });

    it("refuses a provider class whose static provide is a getter", () => {
      @Injectable()
      class Described {}
      withGetter(Described, "provide", undefined);
      @Module({ providers: [Described] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "module-refused",
      });
    });
  });

  describe("in a module", () => {
    @Module({})
    class Harmless {}

    it("refuses the plugin's module given as a proxy", () => {
      @Module({})
      class PluginModule {}

      expect(
        sealPluginModule(new Proxy({ module: PluginModule }, {}), OPTIONS),
      ).toMatchObject({ reason: "module-invalid" });
    });

    it("refuses a list a dynamic module gives through a getter", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal(withGetter({ module: PluginModule }, "providers", [])),
      ).toMatchObject({ reason: "module-refused" });
    });

    it("refuses an import whose module is a getter", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal({
          module: PluginModule,
          imports: [withGetter({}, "module", Harmless) as DynamicModule],
        }),
      ).toMatchObject({ reason: "module-refused" });
    });

    it("refuses a dynamic module whose global is a getter", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal(withGetter({ module: PluginModule }, "global", false)),
      ).toMatchObject({ reason: "module-refused" });
    });

    // NestJS spreads a dynamic module, which runs every getter it holds,
    // including under a key the seal itself never reads.
    it("refuses a dynamic module whose exports is a getter", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal(withGetter({ module: PluginModule }, "exports", [])),
      ).toMatchObject({ reason: "module-refused" });
    });

    it("refuses a getter on a field a dynamic module does not have", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal(withGetter({ module: PluginModule }, "anything", [])),
      ).toMatchObject({ reason: "module-refused" });
    });

    it("refuses a field a dynamic module does not have", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal({ module: PluginModule, anything: [] } as DynamicModule),
      ).toMatchObject({ reason: "module-refused" });
    });

    it("refuses an imported dynamic module whose exports is a getter", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal({
          module: PluginModule,
          imports: [withGetter({ module: Harmless }, "exports", [])],
        }),
      ).toMatchObject({ reason: "module-refused" });
    });

    it("fixes the exports of a dynamic module to what it holds", () => {
      @Module({})
      class PluginModule {}
      const module: DynamicModule = { module: PluginModule, exports: [] };

      expect(seal(module)).toMatchObject({ ok: true });
      expect(Object.getOwnPropertyDescriptor(module, "exports")).toMatchObject({
        writable: false,
        configurable: false,
      });
    });

    it("refuses an import whose forwardRef is a getter", () => {
      @Module({})
      class PluginModule {}

      expect(
        seal({
          module: PluginModule,
          imports: [withGetter({}, "forwardRef", () => Harmless) as never],
        }),
      ).toMatchObject({ reason: "module-refused" });
    });

    it("refuses a module class whose configure is a getter", () => {
      @Module({})
      class PluginModule {}
      withGetter(PluginModule.prototype, "configure", undefined);

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "module-refused",
      });
    });
  });

  describe("on a chain the seal walks", () => {
    it("refuses a class that inherits through a proxy", () => {
      @Injectable()
      class Base {}
      class Sneaky extends (new Proxy(Base, {}) as typeof Base) {}
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "module-refused",
      });
    });

    it("refuses a class whose methods sit behind a proxy", () => {
      @Injectable()
      class Sneaky {}
      Object.setPrototypeOf(Sneaky.prototype, new Proxy({}, {}));
      @Module({ providers: [Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "module-refused",
      });
    });

    it("refuses a function whose heritage is a getter", () => {
      // reflect-metadata reads the superclass of a function like this one from
      // the `constructor` above its prototype.
      function Sneaky() {}
      const above = withGetter({}, "constructor", OwnHelper);
      Sneaky.prototype = Object.create(above) as object;
      @Module({ providers: [Sneaky as never] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "module-refused",
      });
    });
  });
});

/**
 * NestJS calls a forward reference's thunk wherever it meets the reference, and
 * the thunk is the plugin's code. The seal calls it once and fixes the
 * reference to what it checked.
 */
describe("a forward reference the seal follows", () => {
  @Injectable()
  class OwnHelper {}

  it("is fixed to the module it was checked as", () => {
    @Global()
    @Module({})
    class Everywhere {}
    @Module({})
    class Harmless {}
    @Module({})
    class PluginModule {}
    let calls = 0;
    const reference = forwardRef(() => {
      calls += 1;
      return calls === 1 ? Harmless : Everywhere;
    });

    expect(seal({ module: PluginModule, imports: [reference] }).ok).toBe(true);
    expect(reference.forwardRef()).toBe(Harmless);
    expect(reference.forwardRef()).toBe(Harmless);
    expect(calls).toBe(1);
  });

  it("is fixed to the token it was checked as", () => {
    class PrismaService {}
    let calls = 0;
    const reference = forwardRef(() => {
      calls += 1;
      return calls === 1 ? OwnHelper : PrismaService;
    });
    @Injectable()
    class Sneaky {
      constructor(@Inject(reference) readonly helper: unknown) {}
    }
    @Module({ providers: [OwnHelper, Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule }).ok).toBe(true);
    const injector = new Injector();
    expect(injector.resolveParamToken({} as never, reference as never)).toBe(
      OwnHelper,
    );
    expect(injector.resolveParamToken({} as never, reference as never)).toBe(
      OwnHelper,
    );
  });

  it("is refused as an import when it cannot be fixed", () => {
    @Module({})
    class Harmless {}
    @Module({})
    class PluginModule {}

    expect(
      seal({
        module: PluginModule,
        imports: [Object.freeze(forwardRef(() => Harmless))],
      }),
    ).toMatchObject({ reason: "module-refused" });
  });

  it("is refused as a token when it cannot be fixed", () => {
    @Injectable()
    class Sneaky {
      constructor(
        @Inject(Object.freeze(forwardRef(() => OwnHelper)))
        readonly helper: unknown,
      ) {}
    }
    @Module({ providers: [OwnHelper, Sneaky] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "forbidden-injection",
    });
  });

  it("keeps its pin when the module is sealed again", () => {
    @Module({})
    class Harmless {}
    @Module({})
    class PluginModule {}
    let calls = 0;
    const reference = forwardRef(() => {
      calls += 1;
      return Harmless;
    });
    const module = { module: PluginModule, imports: [reference] };

    expect(seal(module).ok).toBe(true);
    const pinned = Object.getOwnPropertyDescriptor(reference, "forwardRef");
    expect(pinned).toMatchObject({ writable: false, configurable: false });
    expect(reference.forwardRef()).toBe(Harmless);

    expect(seal(module).ok).toBe(true);
    expect(Object.getOwnPropertyDescriptor(reference, "forwardRef")).toEqual(
      pinned,
    );
    expect(reference.forwardRef()).toBe(Harmless);
    expect(calls).toBe(1);
  });

  /**
   * The thunk is called on the reference it belongs to, after the seal has read
   * that reference, so what it does to the reference is read again.
   */
  describe("a thunk that changes its own reference", () => {
    @Module({})
    class Harmless {}
    @Module({})
    class PluginModule {}

    function changing(change: (reference: object) => void) {
      const reference: object = forwardRef(() => {
        change(reference);
        return Harmless;
      });
      return reference;
    }

    it("is refused when it gives the reference a then", () => {
      const reference = changing((own) => {
        // oxlint-disable-next-line unicorn/no-thenable -- the shape under test
        Object.assign(own, { then: () => undefined });
      });

      expect(
        seal({ module: PluginModule, imports: [reference as never] }),
      ).toMatchObject({ ok: false, reason: "module-refused" });
    });

    it("is refused when it gives the reference a promise's prototype", () => {
      const reference = changing((own) => {
        Object.setPrototypeOf(own, Promise.prototype);
      });

      expect(
        seal({ module: PluginModule, imports: [reference as never] }),
      ).toMatchObject({ ok: false, reason: "module-refused" });
    });

    it("is refused when it gives the reference a module", () => {
      const reference = changing((own) => {
        Object.assign(own, { module: Harmless });
      });

      expect(
        seal({ module: PluginModule, imports: [reference as never] }),
      ).toMatchObject({ ok: false, reason: "module-refused" });
    });

    it("is refused when it freezes the reference first", () => {
      const reference = changing((own) => {
        Object.freeze(own);
      });

      expect(
        seal({ module: PluginModule, imports: [reference as never] }),
      ).toMatchObject({ ok: false, reason: "module-refused" });
    });

    it("leaves a reference nothing can change after it is checked", () => {
      const reference = changing(() => undefined);

      expect(
        seal({ module: PluginModule, imports: [reference as never] }).ok,
      ).toBe(true);
      expect(Object.isFrozen(reference)).toBe(true);
      expect(() => Object.setPrototypeOf(reference, Promise.prototype)).toThrow(
        TypeError,
      );
    });
  });

  it("is fixed onto a reference that was handed another's pin", () => {
    @Module({})
    class Harmless {}
    @Module({})
    class Other {}
    @Module({})
    class PluginModule {}
    const first = forwardRef(() => Harmless);
    const handed: { forwardRef?: unknown } = {};
    // Called after `first` is pinned and before `handed` is read.
    const between = forwardRef(() => {
      handed.forwardRef = first.forwardRef;
      return Other;
    });

    expect(
      seal({
        module: PluginModule,
        imports: [first, between, handed as never],
      }).ok,
    ).toBe(true);
    expect(Object.getOwnPropertyDescriptor(handed, "forwardRef")).toMatchObject(
      { value: first.forwardRef, writable: false, configurable: false },
    );
  });

  /**
   * NestJS calls `reference.forwardRef()`, so the thunk's `this` is the
   * reference, and a thunk may answer from it.
   */
  describe("a thunk that reads the reference it is called on", () => {
    function readingTarget(target: unknown, fallback: unknown) {
      return Object.assign(
        forwardRef(function (this: { target?: unknown } | undefined) {
          return this?.target ?? fallback;
        }),
        { target },
      );
    }

    it("is fixed to the module NestJS would import", () => {
      @Module({})
      class Expected {}
      @Module({})
      class Fallback {}
      @Module({})
      class PluginModule {}
      const reference = readingTarget(Expected, Fallback);
      expect(reference.forwardRef()).toBe(Expected);

      expect(seal({ module: PluginModule, imports: [reference] }).ok).toBe(
        true,
      );
      expect(reference.forwardRef()).toBe(Expected);
    });

    it("is fixed to the token NestJS would inject", () => {
      @Injectable()
      class Expected {}
      @Injectable()
      class Fallback {}
      const reference = readingTarget(Expected, Fallback);
      @Injectable()
      class Consumer {
        constructor(@Inject(reference) readonly helper: unknown) {}
      }
      @Module({ providers: [Expected, Fallback, Consumer] })
      class PluginModule {}
      const injector = new Injector();
      expect(injector.resolveParamToken({} as never, reference as never)).toBe(
        Expected,
      );

      expect(seal({ module: PluginModule }).ok).toBe(true);
      expect(injector.resolveParamToken({} as never, reference as never)).toBe(
        Expected,
      );
    });

    it("is refused when what NestJS would inject is denied", () => {
      class PrismaService {}
      @Injectable()
      class Sneaky {
        constructor(
          @Inject(readingTarget(PrismaService, OwnHelper))
          readonly helper: unknown,
        ) {}
      }
      @Module({ providers: [OwnHelper, Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule })).toMatchObject({
        reason: "forbidden-injection",
      });
    });
  });
});

/**
 * NestJS registers a dynamic module's imports as they are listed, and keys a
 * forward reference there by the reference object itself, which it writes an
 * id onto. The reference the seal fixed takes no new property, so the list is
 * given the module the reference resolved to instead.
 */
describe("a forward reference in a dynamic module's imports", () => {
  let built = 0;
  @Injectable()
  class Helper {
    constructor() {
      built += 1;
    }
  }
  @Module({ providers: [Helper], exports: [Helper] })
  class Shared {}
  @Injectable()
  class Consumer {
    constructor(@Inject(Helper) readonly helper: Helper) {}
  }

  async function consumerBuiltFrom(module: DynamicModule) {
    const sealed = seal(module);
    if (!sealed.ok) {
      throw new Error(
        `The module was refused before it was built: ${sealed.log}`,
      );
    }
    built = 0;
    const context = await NestFactory.createApplicationContext(sealed.module, {
      logger: false,
      abortOnError: false,
    });
    try {
      return context.get(Consumer, { strict: false });
    } finally {
      await context.close();
    }
  }

  it("is built and resolved in the plugin's own module", async () => {
    @Module({})
    class PluginModule {}
    const imports = [forwardRef(() => Shared)];

    const consumer = await consumerBuiltFrom({
      module: PluginModule,
      providers: [Consumer],
      imports,
    });

    expect(consumer.helper).toBeInstanceOf(Helper);
    expect(built).toBe(1);
    expect(imports).toEqual([Shared]);
  });

  it("is built and resolved in a dynamic module the plugin imports", async () => {
    @Module({})
    class Middle {}
    @Module({})
    class PluginModule {}

    const consumer = await consumerBuiltFrom({
      module: PluginModule,
      imports: [
        {
          module: Middle,
          providers: [Consumer],
          imports: [forwardRef(() => Shared)],
        },
      ],
    });

    expect(consumer.helper).toBeInstanceOf(Helper);
  });

  it("is built and resolved when it resolves to a dynamic module", async () => {
    @Module({})
    class PluginModule {}

    const consumer = await consumerBuiltFrom({
      module: PluginModule,
      providers: [Consumer],
      imports: [
        forwardRef(() => ({
          module: Shared,
        })),
      ],
    });

    expect(consumer.helper).toBeInstanceOf(Helper);
  });

  it("is left in place in a module class's imports", async () => {
    @Module({ imports: [forwardRef(() => Shared)], providers: [Consumer] })
    class PluginModule {}

    const consumer = await consumerBuiltFrom({ module: PluginModule });

    expect(consumer.helper).toBeInstanceOf(Helper);
  });

  it("is refused when the list cannot take the module", () => {
    @Module({})
    class PluginModule {}

    const result = seal({
      module: PluginModule,
      imports: Object.freeze([forwardRef(() => Shared)]) as never,
    });

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain("imports");
  });

  it("leaves the list closed to an entry a thunk adds to it", () => {
    @Module({})
    class Unchecked {}
    @Module({})
    class PluginModule {}
    const imports: unknown[] = [];
    imports.push(
      forwardRef(() => {
        try {
          imports.push(Unchecked);
        } catch {
          // Closed by the seal.
        }
        return Shared;
      }),
    );

    expect(seal({ module: PluginModule, imports: imports as never }).ok).toBe(
      true,
    );
    expect(imports).toEqual([Shared]);
    expect(Object.isFrozen(imports)).toBe(true);
  });

  it("is refused when a thunk replaces another entry in it", () => {
    @Module({})
    class Unchecked {}
    @Module({})
    class PluginModule {}
    const imports: unknown[] = [Shared];
    imports.push(
      forwardRef(() => {
        imports[0] = Unchecked;
        return Shared;
      }),
    );

    const result = seal({ module: PluginModule, imports: imports as never });

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain("changed its `imports`");
  });

  it("is refused when a thunk makes the list longer", () => {
    @Module({})
    class PluginModule {}
    const imports: unknown[] = [];
    imports.push(
      forwardRef(() => {
        imports.length = 2;
        return Shared;
      }),
    );

    const result = seal({ module: PluginModule, imports: imports as never });

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain("changed its `imports`");
  });

  it("is refused when a thunk makes the list shorter", () => {
    @Module({})
    class PluginModule {}
    const imports: unknown[] = [];
    imports.push(
      forwardRef(() => {
        imports.length = 0;
        return Shared;
      }),
    );

    const result = seal({ module: PluginModule, imports: imports as never });

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain("imports");
  });

  it("is checked as the module it resolves to", () => {
    @Global()
    @Module({})
    class Everywhere {}
    @Module({})
    class PluginModule {}
    const imports = [forwardRef(() => Everywhere)];

    const result = seal({ module: PluginModule, imports });

    expect(result.ok ? "" : result.log).toContain("global");
  });
});

/**
 * What a controller's routes require and where they are mounted is metadata
 * the plugin wrote, and the guard and the router read it after the seal. A
 * list that brings its own methods answers whoever asks it, so the seal reads
 * only a plain array and writes the class's list back as one of its own.
 */
describe("a controller's lists, read as the guard and the router read them", () => {
  function own<List extends unknown[]>(
    list: List,
    key: PropertyKey,
    value: unknown,
  ): List {
    Object.defineProperty(list, key, { value });
    return list;
  }

  it("refuses capabilities that answer whether they hold the floor", () => {
    @Controller("open")
    class Open {
      @Get()
      index(): string {
        return "";
      }
    }
    Reflect.defineMetadata(
      REQUIRED_CAPABILITIES,
      own([], "includes", () => true),
      Open,
    );
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Open] })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("refuses a route's capabilities that merge in the class's their own way", () => {
    @Controller("open")
    class Open {
      @Get()
      index(): string {
        return "";
      }
    }
    const handler = handlerOf(Open, "index");
    Reflect.defineMetadata(
      REQUIRED_CAPABILITIES,
      own([], "concat", () => []),
      handler,
    );
    @Module({})
    class PluginModule {}

    // What the guard would require, had the class carried the floor.
    Reflect.defineMetadata(REQUIRED_CAPABILITIES, [...OPTIONS.floor], Open);
    expect(
      new Reflector().getAllAndMerge(REQUIRED_CAPABILITIES, [
        handler as () => unknown,
        Open,
      ]),
    ).toEqual([]);
    Reflect.deleteMetadata(REQUIRED_CAPABILITIES, Open);

    expect(seal({ module: PluginModule, controllers: [Open] })).toMatchObject({
      reason: "module-refused",
    });
  });

  it("writes the class's capabilities back as a list of its own", () => {
    @Controller("board")
    class Board {
      @Get()
      index(): string {
        return "";
      }
    }
    const declared = [...OPTIONS.floor];
    Reflect.defineMetadata(REQUIRED_CAPABILITIES, declared, Board);
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Board] }).ok).toBe(true);
    expect(capabilitiesOf(Board)).toEqual([...OPTIONS.floor]);
    expect(capabilitiesOf(Board)).not.toBe(declared);
  });

  it("writes a route's capabilities back as a list of its own", () => {
    @Controller("board")
    class Board {
      @Get()
      @RequireCapability("association:manage")
      index(): string {
        return "";
      }
    }
    const handler = handlerOf(Board, "index");
    const declared = capabilitiesOf(handler);
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Board] }).ok).toBe(true);
    expect(capabilitiesOf(handler)).toEqual(["association:manage"]);
    expect(capabilitiesOf(handler)).not.toBe(declared);
    expect(Object.isFrozen(capabilitiesOf(handler))).toBe(true);
  });

  /**
   * The guard merges the route's list into the class's with `concat` and then
   * filters the result, and both walk every position up to the length. A list
   * holding one entry and claiming billions of positions would cost that walk
   * on every request to the route.
   */
  it("writes a route's sparse capabilities back holding only their entries", () => {
    @Controller("board")
    class Board {
      @Get()
      index(): string {
        return "";
      }
    }
    const handler = handlerOf(Board, "index");
    const sparse: string[] = ["association:manage"];
    sparse.length = 2 ** 32 - 1;
    Reflect.defineMetadata(REQUIRED_CAPABILITIES, sparse, handler);
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Board] }).ok).toBe(true);
    const written = capabilitiesOf(handler) as unknown[];
    // Compared by length first, so a failure does not print the sparse list.
    expect(written.length).toBe(1);
    expect(written).toEqual(["association:manage"]);
  });

  it("gives a route that asked for no capabilities no list of its own", () => {
    @Controller("board")
    class Board {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}

    expect(seal({ module: PluginModule, controllers: [Board] }).ok).toBe(true);
    expect(
      Reflect.hasOwnMetadata(REQUIRED_CAPABILITIES, handlerOf(Board, "index")),
    ).toBe(false);
  });

  it("refuses a controller's paths with their own iterator", () => {
    @Controller()
    class Reports {
      @Get()
      index(): string {
        return "";
      }
    }
    Reflect.defineMetadata(
      PATH_METADATA,
      own(["../../api/address-book"], Symbol.iterator, function* () {
        yield "reports";
      }),
      Reports,
    );
    @Module({})
    class PluginModule {}

    expect(
      seal({ module: PluginModule, controllers: [Reports] }),
    ).toMatchObject({ reason: "module-refused" });
  });

  it("refuses a route's paths with their own iterator", () => {
    @Controller("reports")
    class Reports {
      @Get()
      index(): string {
        return "";
      }
    }
    Reflect.defineMetadata(
      PATH_METADATA,
      own(["../../api/address-book"], Symbol.iterator, function* () {
        yield "monthly";
      }),
      handlerOf(Reports, "index"),
    );
    @Module({})
    class PluginModule {}

    expect(
      seal({ module: PluginModule, controllers: [Reports] }),
    ).toMatchObject({ reason: "module-refused" });
  });

  it("names a path that is not a string without writing it out", () => {
    let written = 0;
    @Controller()
    class Reports {
      @Get()
      index(): string {
        return "";
      }
    }
    Reflect.defineMetadata(
      PATH_METADATA,
      {
        toJSON() {
          written += 1;
          return REVEALING;
        },
      },
      Reports,
    );
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, controllers: [Reports] });

    expect(result).toMatchObject({ reason: "module-refused" });
    expect(result.ok ? "" : result.log).not.toContain("anna");
    expect(written).toBe(0);
  });
});

/**
 * The guard is told which class a request reached by the instance's
 * `constructor`, found on the controller's prototype, and reads the capability
 * floor from that class. A prototype naming any other class would have the
 * guard read the floor from a class the seal never wrote it onto, so the seal
 * refuses one before the application is built.
 */
describe("a controller whose prototype names another class", () => {
  const NAMES_ANOTHER =
    'The controller "Reports" has a prototype that does not name it as its ' +
    "constructor";

  @Module({})
  class PluginModule {}

  function sealed(controller: unknown) {
    return seal({ module: PluginModule, controllers: [controller as Type] });
  }

  it("is refused when its prototype names another class", () => {
    @Controller("reports")
    class Reports {
      @Get()
      index(): string {
        return "";
      }
    }
    Object.defineProperty(Reports.prototype, "constructor", { value: Object });

    const result = sealed(Reports);

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain(NAMES_ANOTHER);
  });

  it("is refused when its prototype only inherits a constructor", () => {
    @Controller("reports")
    class Reports {
      @Get()
      index(): string {
        return "";
      }
    }
    Reflect.deleteProperty(Reports.prototype, "constructor");

    const result = sealed(Reports);

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain(NAMES_ANOTHER);
  });

  it("is refused as an ES5-style subclass whose prototype names its base", () => {
    function Base(): void {}
    function Reports(): void {}
    Reports.prototype = Object.create(Base.prototype as object) as object;
    Controller("reports")(Reports);

    const result = sealed(Reports);

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain(NAMES_ANOTHER);
    // Nothing was written onto a controller that was refused.
    expect(capabilitiesOf(Reports)).toBeUndefined();
  });

  it("is sealed as an ES5-style subclass whose prototype names it", () => {
    function Base(): void {}
    function Reports(): void {}
    Reports.prototype = Object.create(Base.prototype as object, {
      constructor: { value: Reports, writable: true, configurable: true },
    }) as object;
    Controller("reports")(Reports);

    expect(sealed(Reports).ok).toBe(true);
    expect(capabilitiesOf(Reports)).toEqual([...OPTIONS.floor]);
  });

  it("is refused without running a constructor kept behind a getter", () => {
    let ran = 0;
    @Controller("reports")
    class Reports {
      @Get()
      index(): string {
        return "";
      }
    }
    Object.defineProperty(Reports.prototype, "constructor", {
      get: () => {
        ran += 1;
        return Reports;
      },
    });

    const result = sealed(Reports);

    expect(result).toMatchObject({ ok: false, reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain(
      "keeps its `constructor` behind a getter",
    );
    expect(ran).toBe(0);
  });
});

/**
 * A class in the graph is the plugin's, and so is everything it answers when
 * read: its name included. The seal asks a proxy nothing, and takes a name
 * only as a data property and only as far as it is safe in a log line.
 */
describe("a class the seal names or reads", () => {
  /** A proxy of `target` that counts the reads made through it. */
  function counted<Target extends object>(
    target: Target,
  ): { proxy: Target; reads: () => number } {
    let reads = 0;
    const proxy = new Proxy(target, {
      get(held, key, receiver) {
        reads += 1;
        return Reflect.get(held, key, receiver) as unknown;
      },
      getOwnPropertyDescriptor(held, key) {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(held, key);
      },
    });
    return { proxy, reads: () => reads };
  }

  it("refuses a module class given as a proxy without asking it anything", () => {
    @Module({})
    class PluginModule {}
    const { proxy, reads } = counted(PluginModule);

    const result = seal({ module: proxy });

    expect(result).toMatchObject({ reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain("is a proxy");
    expect(reads()).toBe(0);
  });

  it("refuses a provider class given as a proxy as one", () => {
    @Injectable()
    class Helper {}
    const { proxy, reads } = counted(Helper);
    @Module({ providers: [proxy] })
    class PluginModule {}

    const result = seal({ module: PluginModule });

    expect(result).toMatchObject({ reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain("is a proxy");
    expect(reads()).toBe(0);
  });

  it("refuses a controller given as a proxy as one", () => {
    @Controller("reports")
    class Reports {}
    const { proxy, reads } = counted(Reports);
    @Module({ controllers: [proxy] })
    class PluginModule {}

    const result = seal({ module: PluginModule });

    expect(result).toMatchObject({ reason: "module-refused" });
    expect(result.ok ? "" : result.log).toContain("is a proxy");
    expect(reads()).toBe(0);
  });

  it("keeps a sealed controller's paths to one bounded line of the log", () => {
    @Controller(["reports\n[Nest] 1 - LOG Plugin loaded", "x".repeat(5000)])
    class Reports {}
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, controllers: [Reports] });

    expect(result.ok).toBe(true);
    const logged = result.ok ? result.controllers.join(", ") : "";
    expect(logged).not.toMatch(/[\r\n]/);
    expect(logged).toContain("api/plugin/occupancy/reports\\n");
    expect(logged.length).toBeLessThan(400);
    // What routing reads is what the plugin declared, under the prefix.
    expect(Reflect.getMetadata(PATH_METADATA, Reports)).toEqual([
      "api/plugin/occupancy/reports\n[Nest] 1 - LOG Plugin loaded",
      `api/plugin/occupancy/${"x".repeat(5000)}`,
    ]);
  });

  it("escapes the characters a reader of the log may end a line at", () => {
    @Controller(["a\u2028b", "c\u2029d", "e\u0085f"])
    class Reports {}
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, controllers: [Reports] });

    expect(result.ok).toBe(true);
    const logged = result.ok ? result.controllers.join(", ") : "";
    expect(logged).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(logged).toContain("a\\u2028b");
    expect(logged).toContain("c\\u2029d");
    expect(logged).toContain("e\\u0085f");
  });

  it("repeats only the first of a controller's many paths", () => {
    @Controller(Array.from({ length: 50 }, (_, index) => `p${index}`))
    class Many {}
    @Module({})
    class PluginModule {}

    const result = seal({ module: PluginModule, controllers: [Many] });

    const logged = result.ok ? result.controllers[0] : "";
    expect(logged).toContain("api/plugin/occupancy/p9");
    expect(logged).not.toContain("p10");
    expect(logged).toContain("and 40 more");
  });

  it("names a module without running a getter for its name", () => {
    let calls = 0;
    @Global()
    @Module({})
    class Everywhere {}
    Object.defineProperty(Everywhere, "name", {
      get() {
        calls += 1;
        return "Everywhere";
      },
    });

    const result = seal({ module: Everywhere });

    expect(result).toMatchObject({ reason: "module-refused" });
    expect(calls).toBe(0);
  });

  it("keeps a class's name to one line of the log", () => {
    @Global()
    @Module({})
    class Everywhere {}
    Object.defineProperty(Everywhere, "name", {
      value: "Everywhere\n[Nest] 1 - LOG Plugin loaded",
    });

    const result = seal({ module: Everywhere });

    expect(result).toMatchObject({ reason: "module-refused" });
    expect(result.ok ? "" : result.log).not.toContain("\n");
  });

  it("seals a module and a controller whose names are getters without running them", () => {
    // Retained and recorded in ADR 0008: the seal decides nothing by these
    // names, and NestJS reads a module's name itself when it builds it.
    let calls = 0;
    const name = {
      get() {
        calls += 1;
        return "Named";
      },
    };
    @Controller("reports")
    class Reports {}
    Object.defineProperty(Reports, "name", name);
    @Module({ controllers: [Reports] })
    class PluginModule {}
    Object.defineProperty(PluginModule, "name", name);

    const result = seal({ module: PluginModule });

    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("refuses a provider whose name is a getter, whatever it answers", () => {
    @Injectable()
    class Helper {}
    Object.defineProperty(Helper, "name", { get: () => "Helper" });
    @Module({ providers: [Helper] })
    class PluginModule {}

    expect(seal({ module: PluginModule })).toMatchObject({
      reason: "module-refused",
    });
  });
});

/**
 * NestJS asks a module's instance whether it registers middleware, and building
 * the instance runs the plugin's code. The seal reads each instance once the
 * application is built.
 */
describe("a plugin's module as NestJS builds it", () => {
  async function sealBuilt(module: DynamicModule) {
    const sealed = seal(module);
    if (!sealed.ok) {
      throw new Error(
        `The module was refused before it was built: ${sealed.log}`,
      );
    }
    const context = await NestFactory.createApplicationContext(sealed.module, {
      logger: false,
      abortOnError: false,
    });
    const built = [...context.get(ModulesContainer).values()];
    const host = await hostModules([], context);
    await context.close();
    return {
      refusal: sealModuleInstances(sealed.module, built, host),
      instance: built.find((each) => each.metatype === module.module)
        ?.instance as object,
    };
  }

  function middleware(consumer: MiddlewareConsumer): void {
    consumer.apply(() => undefined).forRoutes("*");
  }

  it("refuses a module whose constructor gives its instance a configure", async () => {
    @Module({})
    class PluginModule {
      constructor() {
        Object.assign(this, { configure: middleware });
      }
    }

    const { refusal } = await sealBuilt({ module: PluginModule });

    expect(refusal).toContain("middleware");
  });

  it("refuses a module whose field gives its instance a configure", async () => {
    @Module({})
    class PluginModule {
      readonly configure = middleware;
    }

    expect((await sealBuilt({ module: PluginModule })).refusal).toContain(
      "middleware",
    );
  });

  it("refuses a module whose base class's constructor gives it one", async () => {
    class Base {
      constructor() {
        Object.assign(this, { configure: middleware });
      }
    }
    @Module({})
    class PluginModule extends Base {}

    expect((await sealBuilt({ module: PluginModule })).refusal).toContain(
      "middleware",
    );
  });

  it("refuses a module whose instance is given a prototype that has one", async () => {
    @Module({})
    class PluginModule {
      constructor() {
        Object.setPrototypeOf(this, { configure: middleware });
      }
    }

    expect((await sealBuilt({ module: PluginModule })).refusal).toContain(
      "middleware",
    );
  });

  it("refuses a module whose instance keeps its configure behind a getter", async () => {
    @Module({})
    class PluginModule {
      constructor() {
        Object.defineProperty(this, "configure", { get: () => undefined });
      }
    }

    expect((await sealBuilt({ module: PluginModule })).refusal).toContain(
      "getter or a proxy",
    );
  });

  it("refuses a module whose constructor builds a proxy", async () => {
    @Module({})
    class PluginModule {
      constructor() {
        return new Proxy(this, {});
      }
    }

    expect((await sealBuilt({ module: PluginModule })).refusal).toContain(
      "getter or a proxy",
    );
  });

  it("refuses a module that freezes its instance", async () => {
    @Module({})
    class PluginModule {
      constructor() {
        Object.freeze(this);
      }
    }

    expect((await sealBuilt({ module: PluginModule })).refusal).toContain(
      "could not be fixed",
    );
  });

  it("refuses an imported module that gives its instance a configure", async () => {
    @Module({})
    class Imported {
      constructor() {
        Object.assign(this, { configure: middleware });
      }
    }
    @Module({ imports: [Imported] })
    class PluginModule {}

    expect((await sealBuilt({ module: PluginModule })).refusal).toContain(
      '"Imported"',
    );
  });

  it("fixes a module without middleware so nothing gives it one later", async () => {
    @Module({})
    class PluginModule {}

    const { refusal, instance } = await sealBuilt({ module: PluginModule });

    expect(refusal).toBeNull();
    expect(Object.getOwnPropertyDescriptor(instance, "configure")).toEqual({
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(() => Object.assign(instance, { configure: middleware })).toThrow(
      TypeError,
    );
  });

  it("refuses a module the seal never read", () => {
    @Module({})
    class PluginModule {}

    expect(sealModuleInstances({ module: PluginModule }, [])).not.toBeNull();
  });

  it("refuses rather than throws when reading the module throws", () => {
    @Module({})
    class PluginModule {}
    const sealed = seal({ module: PluginModule });
    if (!sealed.ok) {
      throw new Error(sealed.log);
    }
    const built = {
      token: "",
      metatype: PluginModule,
      isGlobal: false,
      imports: new Set<never>(),
      providers: new Map<never, never>(),
      controllers: new Map<never, never>(),
      injectables: new Map<never, never>(),
      get instance(): unknown {
        throw new Error(REVEALING);
      },
    };

    const refusal = sealModuleInstances(sealed.module, [built]);

    expect(refusal).not.toBeNull();
    expect(refusal).not.toContain(REVEALING);
  });
});

/**
 * What a plugin's code changes after the seal has read it.
 *
 * The seal reads a module's lists, checks them, and only then follows its
 * imports, whose forward references are the plugin's code - as are the thunks
 * of the tokens a provider is injected with, and anything the plugin's factory
 * scheduled before it returned. Each of them can still reach what the seal has
 * already checked, and NestJS reads it again afterwards. What was checked has
 * to stay what NestJS reads, or the plugin is refused.
 */
describe("what a plugin changes once the seal has read it", () => {
  @Injectable()
  class RefuseEverything implements CanActivate {
    canActivate(): boolean {
      return false;
    }
  }
  const GUARD = { provide: APP_GUARD, useClass: RefuseEverything };

  @Module({})
  class Harmless {}

  function sealed(module: DynamicModule, source = ""): DynamicModule {
    const result = sealPluginModule(module, { ...OPTIONS, source });
    if (!result.ok) {
      throw new Error(`The module was refused: ${result.log}`);
    }
    return result.module;
  }

  describe("from a thunk the seal calls", () => {
    it("cannot add to a list of an import's module the seal has checked", () => {
      @Module({})
      class PluginModule {}
      const providers: Provider[] = [];

      const result = seal({
        module: PluginModule,
        providers,
        imports: [
          forwardRef(() => {
            providers.push(GUARD);
            return Harmless;
          }),
        ],
      });

      expect(result).toMatchObject({ ok: false, reason: "module-refused" });
      expect(providers).toEqual([]);
    });

    it("leaves the list as it was checked when the thunk ignores the failure", () => {
      @Module({})
      class PluginModule {}
      const providers: Provider[] = [];

      const result = seal({
        module: PluginModule,
        providers,
        imports: [
          forwardRef(() => {
            try {
              providers.push(GUARD);
            } catch {
              // What a plugin that expects the refusal would write.
            }
            return Harmless;
          }),
        ],
      });

      expect(result.ok).toBe(true);
      expect(providers).toEqual([]);
    });

    it("cannot give the module another list of the same name", () => {
      const module: DynamicModule = {
        module: class PluginModule {},
        providers: [],
        imports: [],
      };
      Module({})(module.module);
      (module.imports as unknown[]).push(
        forwardRef(() => {
          try {
            Object.assign(module, { providers: [GUARD] });
          } catch {
            // Fixed by the seal.
          }
          return Harmless;
        }),
      );

      expect(seal(module).ok).toBe(true);
      expect(module.providers).toEqual([]);
    });

    it("is refused when it gives the module's class other metadata", () => {
      @Module({ providers: [] })
      class PluginModule {}

      const result = seal({
        module: PluginModule,
        imports: [
          forwardRef(() => {
            Reflect.defineMetadata("providers", [GUARD], PluginModule);
            return Harmless;
          }),
        ],
      });

      expect(result).toMatchObject({ ok: false, reason: "module-refused" });
      if (!result.ok) {
        expect(result.log).toContain('"PluginModule" changed its `providers`');
      }
    });

    it("cannot add to the providers from a factory's injected token", () => {
      class Local {}
      const providers: Provider[] = [Local];
      providers.push({
        provide: "report",
        useFactory: (): string => "",
        inject: [
          forwardRef(() => {
            providers.push(GUARD);
            return Local;
          }),
        ],
      } as unknown as Provider);
      @Module({})
      class PluginModule {}

      expect(seal({ module: PluginModule, providers }).ok).toBe(false);
      expect(providers).not.toContain(GUARD);
    });

    it("is refused when an @Inject thunk gives its class other dependencies", () => {
      class PrismaService {}
      @Injectable()
      class Local {}
      @Injectable()
      class Sneaky {
        constructor(
          @Inject(
            forwardRef(() => {
              Reflect.defineMetadata(
                SELF_DECLARED_DEPS_METADATA,
                [{ index: 0, param: PrismaService }],
                Sneaky,
              );
              return Local;
            }),
          )
          readonly local: unknown,
        ) {}
      }
      @Module({ providers: [Local, Sneaky] })
      class PluginModule {}

      const result = seal({ module: PluginModule });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.log).toContain('"Sneaky" changed its `self:paramtypes`');
      }
    });

    it("is refused when it gives a provider another prototype", () => {
      function Legacy(): void {}
      Injectable()(Legacy);
      @Module({})
      class PluginModule {}

      const result = seal({
        module: PluginModule,
        providers: [Legacy as unknown as Provider],
        imports: [
          forwardRef(() => {
            Legacy.prototype = { configure: (): void => undefined };
            return Harmless;
          }),
        ],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.log).toContain('"Legacy" changed its `prototype`');
      }
    });

    it("cannot change a dependency record it was checked with", () => {
      class PrismaService {}
      @Injectable()
      class Local {}
      @Injectable()
      class Sneaky {
        constructor(
          @Inject(forwardRef(() => Local)) readonly local: unknown,
          @Inject(
            forwardRef(() => {
              const [record] = Reflect.getMetadata(
                SELF_DECLARED_DEPS_METADATA,
                Sneaky,
              ) as { param: unknown }[];
              try {
                Object.assign(record ?? {}, { param: PrismaService });
              } catch {
                // Frozen by the seal.
              }
              return Local;
            }),
          )
          readonly other: unknown,
        ) {}
      }
      @Module({ providers: [Local, Sneaky] })
      class PluginModule {}

      expect(seal({ module: PluginModule }).ok).toBe(true);
      const records = Reflect.getMetadata(
        SELF_DECLARED_DEPS_METADATA,
        Sneaky,
      ) as { param: unknown }[];
      expect(records.map(({ param }) => param)).not.toContain(PrismaService);
    });

    /*
     * The seal reads a controller's methods twice: for the enhancers they name
     * while it walks the graph, and for their paths once it has. An import's
     * thunk runs in between, so the second reading must not stand in for the
     * first, or a method only it saw is mounted with enhancers nobody checked.
     */
    describe("on a controller it has already checked", () => {
      class PrismaService {}
      let handedOver = false;
      @Injectable()
      class LaterGuard implements CanActivate {
        constructor(@Inject(PrismaService) readonly db: unknown) {
          handedOver = true;
        }
        canActivate(): boolean {
          return true;
        }
      }
      @Injectable()
      class Local {}

      /** A plain module whose constructor's injected token runs `change`. */
      function importing(change: () => void): Type {
        @Module({ providers: [Local] })
        class Imported {
          constructor(
            @Inject(
              forwardRef(() => {
                change();
                return Local;
              }),
            )
            readonly local: unknown,
          ) {}
        }
        return Imported;
      }

      function guarded(prototype: object, name: string): void {
        const added = function (): string {
          return "";
        };
        Object.defineProperty(prototype, name, {
          value: added,
          writable: true,
          configurable: true,
        });
        const descriptor = { value: added };
        Get(name)(prototype, name, descriptor);
        UseGuards(LaterGuard)(prototype, name, descriptor);
      }

      it("is refused when it adds a guarded route", () => {
        handedOver = false;
        @Controller()
        class Reports {}
        @Module({ controllers: [Reports] })
        class PluginModule {}

        const result = seal({
          module: PluginModule,
          imports: [importing(() => guarded(Reports.prototype, "added"))],
        });

        expect(result).toMatchObject({ ok: false, reason: "module-refused" });
        if (!result.ok) {
          expect(result.log).toContain("changed its `methods`");
        }
        expect(handedOver).toBe(false);
      });

      it("is refused when it replaces a route with a guarded one", () => {
        @Controller()
        class Reports {
          @Get()
          index(): string {
            return "";
          }
        }
        @Module({ controllers: [Reports] })
        class PluginModule {}

        const result = seal({
          module: PluginModule,
          imports: [importing(() => guarded(Reports.prototype, "index"))],
        });

        expect(result).toMatchObject({ ok: false, reason: "module-refused" });
        if (!result.ok) {
          expect(result.log).toContain("changed its `methods`");
        }
      });

      it("is refused when it gives the controller another prototype", () => {
        function Reports(): void {}
        Controller()(Reports);
        @Module({ controllers: [Reports as unknown as Type] })
        class PluginModule {}

        const result = seal({
          module: PluginModule,
          imports: [
            importing(() => {
              Reports.prototype = { constructor: Reports };
              guarded(Reports.prototype as object, "added");
            }),
          ],
        });

        expect(result).toMatchObject({ ok: false, reason: "module-refused" });
        if (!result.ok) {
          expect(result.log).toContain('"Reports" changed its `prototype`');
        }
      });

      it("is refused before the guard is handed the service it asks for", async () => {
        handedOver = false;
        @Global()
        @Module({
          providers: [PrismaService],
          exports: [PrismaService],
        })
        class CoreModule {}
        @Controller()
        class Reports {}
        @Module({ controllers: [Reports] })
        class PluginModule {}
        const module: DynamicModule = {
          module: PluginModule,
          imports: [importing(() => guarded(Reports.prototype, "added"))],
        };

        const result = seal(module);
        if (result.ok) {
          // What the application would go on to do with a module let through.
          @Module({ imports: [CoreModule, result.module] })
          class Application {}
          const context = await NestFactory.createApplicationContext(
            Application,
            { logger: false, abortOnError: false },
          );
          await context.close();
        }

        expect(result.ok).toBe(false);
        expect(handedOver).toBe(false);
      });
    });
  });

  describe("from code that runs between the seal and the build", () => {
    it("cannot add to a list the seal read", () => {
      @Module({})
      class PluginModule {}
      const providers: Provider[] = [];
      const module = sealed({ module: PluginModule, providers });

      expect(() => providers.push(GUARD)).toThrow(TypeError);
      expect(rereadSealedModule(module)).toBeNull();
    });

    it("cannot give a module another list", () => {
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule, providers: [] });

      expect(() => Object.assign(module, { providers: [GUARD] })).toThrow(
        TypeError,
      );
    });

    it("cannot change a provider's declaration", () => {
      @Injectable()
      class Local {}
      const provider = { provide: "report", useClass: Local };
      @Module({})
      class PluginModule {}
      sealed({ module: PluginModule, providers: [provider] });

      expect(() => Object.assign(provider, { provide: APP_GUARD })).toThrow(
        TypeError,
      );
    });

    it("is refused when the module's class is given other metadata", () => {
      @Module({ providers: [] })
      class PluginModule {}
      const module = sealed({ module: PluginModule });

      Reflect.defineMetadata("providers", [GUARD], PluginModule);

      expect(rereadSealedModule(module)).toContain(
        '"PluginModule" changed its `providers`',
      );
    });

    it("is refused when a module is made global", () => {
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule });

      Reflect.defineMetadata(GLOBAL_MODULE_METADATA, true, PluginModule);

      expect(rereadSealedModule(module)).toContain("changed its");
    });

    it("is refused when a controller's path is written again", () => {
      @Controller("reports")
      class Reports {}
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule, controllers: [Reports] });

      Reflect.defineMetadata(PATH_METADATA, "api/members", Reports);

      expect(rereadSealedModule(module)).toContain(
        '"Reports" changed its `path`',
      );
    });

    it("cannot shed the capability floor where it lies", () => {
      @Controller("reports")
      class Reports {}
      @Module({})
      class PluginModule {}
      sealed({ module: PluginModule, controllers: [Reports] });

      const floor = capabilitiesOf(Reports) as unknown[];
      expect(() => floor.splice(0)).toThrow(TypeError);
      expect(capabilitiesOf(Reports)).toEqual(["addressBook:read"]);
    });

    it("is refused when a controller is given a route the seal never saw", () => {
      @Controller("reports")
      class Reports {
        @Get()
        index(): string {
          return "";
        }
      }
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule, controllers: [Reports] });

      function open(): string {
        return "";
      }
      Get("open")(Reports.prototype, "open", { value: open });
      Public()(open);
      Object.defineProperty(Reports.prototype, "open", { value: open });

      expect(rereadSealedModule(module)).toContain("changed its `methods`");
    });

    it("is refused when a provider is given a static provide", () => {
      @Injectable()
      class Local {}
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule, providers: [Local] });

      Object.assign(Local, { provide: APP_GUARD, useClass: RefuseEverything });

      expect(rereadSealedModule(module)).toContain(
        '"Local" changed its `provide`',
      );
    });

    it("finds nothing changed in a module nobody touched", () => {
      @Controller("reports")
      class Reports {
        @Get()
        index(): string {
          return "";
        }
      }
      @Injectable()
      class Local {}
      @Module({ providers: [Local] })
      class Imported {}
      @Module({})
      class PluginModule {}

      const module = sealed({
        module: PluginModule,
        controllers: [Reports],
        imports: [Imported, { module: Harmless, providers: [] }],
      });

      expect(rereadSealedModule(module)).toBeNull();
    });

    it("refuses a module the seal never read", () => {
      @Module({})
      class PluginModule {}

      expect(rereadSealedModule({ module: PluginModule })).not.toBeNull();
    });

    it("refuses rather than throws when reading again throws", () => {
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule });

      Object.setPrototypeOf(PluginModule, new Proxy(Function.prototype, {}));

      expect(rereadSealedModule(module)).not.toBeNull();
    });

    it("finds a getter given to the dynamic module after it was sealed", () => {
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule });

      Object.defineProperty(module, "exports", {
        get: () => [],
        enumerable: true,
      });

      expect(rereadSealedModule(module)).toContain("changed its `fields`");
    });

    it("finds a field given to the dynamic module after it was sealed", () => {
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule });

      Object.assign(module, { anything: [] });

      expect(rereadSealedModule(module)).toContain("changed its `fields`");
    });

    it("reads a module NestJS has built as it was sealed", async () => {
      @Module({})
      class PluginModule {}
      const module = sealed({ module: PluginModule });

      // NestJS writes its own id for the module onto it.
      const context = await NestFactory.createApplicationContext(module, {
        logger: false,
      });
      await context.close();

      expect(Object.getOwnPropertySymbols(module)).not.toEqual([]);
      expect(rereadSealedModule(module)).toBeNull();
    });
  });

  describe("while NestJS builds the module", () => {
    async function built(module: DynamicModule): Promise<string | null> {
      const sealedModule = sealed(module);
      const context = await NestFactory.createApplicationContext(sealedModule, {
        logger: false,
        abortOnError: false,
      });
      const modules = [...context.get(ModulesContainer).values()];
      const host = await hostModules([], context);
      await context.close();
      return sealModuleInstances(sealedModule, modules, host);
    }

    it("builds a module the seal froze as it was read", async () => {
      @Injectable()
      class Local {}
      @Injectable()
      class Uses {
        constructor(@Inject(forwardRef(() => Local)) readonly local: Local) {}
      }
      @Controller("reports")
      class Reports {
        constructor(readonly uses: Uses) {}
        @Get()
        index(): string {
          return "";
        }
      }
      Reflect.defineMetadata("design:paramtypes", [Uses], Reports);
      @Module({ providers: [Local], exports: [Local] })
      class Imported {}

      expect(
        await built({
          module: class PluginModule {},
          imports: [Imported, { module: Harmless, providers: [] }],
          providers: [
            Uses,
            {
              provide: "report",
              useFactory: (): string => "",
              inject: [Local],
            },
          ],
          controllers: [Reports],
        }),
      ).toBeNull();
    });

    it("is refused when a constructor changes what the seal read", async () => {
      @Controller("reports")
      class Reports {}
      @Injectable()
      class Changes {
        constructor() {
          Reflect.defineMetadata(GUARDS_METADATA, [RefuseEverything], Reports);
        }
      }
      @Module({})
      class PluginModule {}

      expect(
        await built({
          module: PluginModule,
          providers: [Changes],
          controllers: [Reports],
        }),
      ).toContain('"Reports" changed its `__guards__`');
    });

    /*
     * NestJS reads a class's name while it builds the module, and a getter
     * there is the plugin's code running in the middle of the build. What it
     * changes, and a constructor NestJS calls later undoes, is gone again by
     * the time anything is read a second time; what NestJS built from it is
     * not.
     */
    it("refuses a guard a name adds while NestJS builds and a constructor takes away", async () => {
      @Module({})
      class Inner {}
      @Injectable()
      class Undoes implements CanActivate {
        constructor() {
          Reflect.deleteMetadata("providers", Inner);
        }
        canActivate(): boolean {
          return false;
        }
      }
      @Module({})
      class PluginModule {}
      let changed = false;
      Object.defineProperty(PluginModule, "name", {
        get: (): string => {
          if (!changed) {
            changed = true;
            Reflect.defineMetadata(
              "providers",
              [{ provide: APP_GUARD, useClass: Undoes }],
              Inner,
            );
          }
          return "PluginModule";
        },
      });

      const refusal = await built({ module: PluginModule, imports: [Inner] });

      expect(changed).toBe(true);
      expect(Reflect.getMetadata("providers", Inner)).toBeUndefined();
      expect(refusal).toContain(
        '"Inner" was built with an application-wide APP_GUARD',
      );
    });

    /*
     * The router reads a route's metadata from a controller instance's
     * prototype and calls the instance's own method of that name, and the
     * guard is told the class a request reached by the instance's
     * `constructor`. The seal reads the class; building the instance runs the
     * plugin's code.
     */
    describe("what a controller is built into", () => {
      /** A route carrying the mark the seal clears on every plugin route. */
      function marked(): string {
        return "marked";
      }
      Get()({}, "marked", { value: marked });
      Reflect.defineMetadata(IS_PUBLIC_ROUTE, true, marked);

      function plugin(controller: Type): DynamicModule {
        @Module({})
        class PluginModule {}
        return { module: PluginModule, controllers: [controller] };
      }

      it("builds a controller as its class declares it", async () => {
        @Injectable()
        class Helper {}
        @Controller("reports")
        class Reports {
          readonly counted = 0;
          constructor(@Inject(Helper) readonly helper: Helper) {}
          @Get()
          index(): string {
            return "";
          }
          helps(): boolean {
            return this.helper instanceof Helper;
          }
        }

        expect(
          await built({
            module: class PluginModule {},
            providers: [Helper],
            controllers: [Reports],
          }),
        ).toBeNull();
      });

      it("builds a controller that inherits its routes", async () => {
        class Base {
          @Get()
          index(): string {
            return "";
          }
        }
        @Controller("reports")
        class Reports extends Base {}

        expect(await built(plugin(Reports))).toBeNull();
      });

      it("refuses an instance holding its own value under a route's name", async () => {
        @Controller("reports")
        class Reports {
          index = marked;
        }
        // A class cannot declare a field and a method under one name, so the
        // route the field stands in for is put on the prototype by hand.
        Object.defineProperty(Reports.prototype, "index", {
          value: function index(): string {
            return "";
          },
          configurable: true,
          writable: true,
        });
        Get()(
          Reports.prototype,
          "index",
          Object.getOwnPropertyDescriptor(Reports.prototype, "index")!,
        );

        expect(await built(plugin(Reports))).toContain(
          'The controller "Reports" was built holding its own `index`',
        );
      });

      it("refuses an instance naming another class as its constructor", async () => {
        class Other {}
        @Controller("reports")
        class Reports {
          constructor() {
            Object.defineProperty(this, "constructor", { value: Other });
          }
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain(
          "was built holding its own `constructor`",
        );
      });

      it("refuses a constructor that returns an object of another class", async () => {
        class Elsewhere {
          @Get()
          index(): string {
            return "";
          }
        }
        @Controller("reports")
        class Reports {
          constructor() {
            return new Elsewhere();
          }
        }

        expect(await built(plugin(Reports))).toContain(
          'The controller "Reports" was built into something other than an ' +
            "instance of the class the seal read.",
        );
      });

      it("refuses a constructor that returns a proxy of its instance", async () => {
        @Controller("reports")
        class Reports {
          constructor() {
            return new Proxy(this, {});
          }
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain(
          "something other than an instance",
        );
      });

      // The seal read the prototype's `constructor`, so it is a read changed.
      it("refuses a constructor that names another class on its prototype", async () => {
        class Other {}
        @Controller("reports")
        class Reports {
          constructor() {
            Object.defineProperty(Reports.prototype, "constructor", {
              value: Other,
            });
          }
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain(
          "changed its `constructor` after the seal read it",
        );
      });

      it("refuses a constructor that replaces a route on its prototype", async () => {
        @Controller("reports")
        class Reports {
          constructor() {
            Object.assign(Reports.prototype, { index: marked });
          }
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain("changed its `methods`");
      });

      it("refuses a constructor that replaces a route with something else", async () => {
        @Controller("reports")
        class Reports {
          constructor() {
            Object.assign(Reports.prototype, { index: undefined });
          }
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain("changed its `methods`");
      });

      it("refuses a constructor that adds a route to its prototype", async () => {
        @Controller("reports")
        class Reports {
          constructor() {
            Object.assign(Reports.prototype, { marked });
          }
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain("changed its `methods`");
      });

      it("refuses a controller built for each request", async () => {
        @Controller({ path: "reports", scope: Scope.REQUEST })
        class Reports {
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain(
          'The controller "Reports" is built for each request or each injection',
        );
      });

      it("refuses a controller that depends on the request", async () => {
        @Controller("reports")
        class Reports {
          constructor(@Inject(REQUEST) readonly request: unknown) {}
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain(
          "is built for each request",
        );
      });

      it("refuses a transient controller", async () => {
        @Controller({ path: "reports", scope: Scope.TRANSIENT })
        class Reports {
          @Get()
          index(): string {
            return "";
          }
        }

        expect(await built(plugin(Reports))).toContain(
          "is built for each request",
        );
      });

      /*
       * The plugin's code runs after the check as well: a timer or a promise
       * before NestJS mounts the routes, its lifecycle hooks once they are
       * mounted. So the instance is fixed as it was checked.
       */
      describe("once it is checked", () => {
        /**
         * Checks what NestJS built, and gives the controller's instance. The
         * plugin's entry holds the source of each class given.
         */
        async function checked(
          controller: Type,
          defined: readonly Type[] = [],
        ): Promise<{ refusal: string | null; instance: object }> {
          const sealedModule = sealed(
            plugin(controller),
            defined
              .map((type) => Function.prototype.toString.call(type))
              .join("\n"),
          );
          const context = await NestFactory.createApplicationContext(
            sealedModule,
            { logger: false, abortOnError: false },
          );
          const modules = [...context.get(ModulesContainer).values()];
          const host = await hostModules([], context);
          await context.close();
          const instance: unknown = modules
            .flatMap((module) => [...module.controllers])
            .find(([token]) => token === controller)?.[1].instance;
          if (typeof instance !== "object" || instance === null) {
            throw new Error("The controller was not built.");
          }
          return {
            refusal: sealModuleInstances(sealedModule, modules, host),
            instance,
          };
        }

        it("keeps the instance's routes from a write to the instance", async () => {
          @Controller("reports")
          class Reports {
            @Get()
            index(): string {
              return "";
            }
          }
          const route = Reflect.get(Reports.prototype, "index");

          const { refusal, instance } = await checked(Reports);

          expect(refusal).toBeNull();
          expect(Reflect.set(instance, "index", marked)).toBe(false);
          expect(Reflect.get(instance, "index")).toBe(route);
          expect(Object.getOwnPropertyDescriptor(instance, "index")).toEqual({
            value: route,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        });

        it("keeps the instance's routes from a write to its class", async () => {
          @Controller("reports")
          class Reports {
            @Get()
            index(): string {
              return "";
            }
          }
          const route = Reflect.get(Reports.prototype, "index");

          const { refusal, instance } = await checked(Reports);

          expect(refusal).toBeNull();
          expect(
            Reflect.defineProperty(Reports.prototype, "index", {
              value: marked,
            }),
          ).toBe(false);
          expect(Reflect.get(instance, "index")).toBe(route);
        });

        it("keeps an inherited route as the seal read it", async () => {
          class Base {
            @Get()
            index(): string {
              return "";
            }
          }
          @Controller("reports")
          class Reports extends Base {}

          const route = Reflect.get(Base.prototype, "index");

          const { refusal, instance } = await checked(Reports);
          Object.defineProperty(Base.prototype, "index", { value: marked });

          expect(refusal).toBeNull();
          expect(Reflect.get(instance, "index")).toBe(route);
        });

        it("keeps the class the guard is told", async () => {
          @Controller("reports")
          class Reports {
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal, instance } = await checked(Reports);

          expect(refusal).toBeNull();
          expect(
            Reflect.defineProperty(Reports.prototype, "constructor", {
              value: Object,
            }),
          ).toBe(false);
          expect(instance.constructor).toBe(Reports);
          expect(Reflect.set(instance, "constructor", Object)).toBe(false);
          expect(Reflect.setPrototypeOf(instance, Object.prototype)).toBe(
            false,
          );
          expect(instance.constructor).toBe(Reports);
        });

        it("keeps the instance and its class's prototype from any change", async () => {
          class Base {
            helps(): boolean {
              return true;
            }
          }
          @Controller("reports")
          class Reports extends Base {
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal, instance } = await checked(Reports, [Reports, Base]);

          expect(refusal).toBeNull();
          expect(Reflect.set(instance, "added", marked)).toBe(false);
          expect(Object.isExtensible(instance)).toBe(false);
          expect(Object.isFrozen(Reports.prototype)).toBe(true);
          expect(Object.isFrozen(Base.prototype)).toBe(true);
          expect(
            Reflect.defineProperty(Base.prototype, "index", { value: marked }),
          ).toBe(false);
        });

        it("leaves a base class the plugin's entry does not define", async () => {
          class Base {
            helps(): boolean {
              return true;
            }
          }
          @Controller("reports")
          class Reports extends Base {
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal } = await checked(Reports, [Reports]);

          expect(refusal).toBeNull();
          expect(Object.isFrozen(Reports.prototype)).toBe(true);
          expect(Object.isFrozen(Base.prototype)).toBe(false);
        });

        it("leaves a class the process shares", async () => {
          class Base extends EventTarget {}
          @Controller("reports")
          class Reports extends Base {
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal } = await checked(Reports, [Reports, Base]);

          expect(refusal).toBeNull();
          expect(Object.isFrozen(Base.prototype)).toBe(true);
          expect(Object.isFrozen(EventTarget.prototype)).toBe(false);
        });

        it("leaves the chain above a base the plugin's entry does not define", async () => {
          class Base {}
          class Middle extends Base {}
          @Controller("reports")
          class Reports extends Middle {
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal } = await checked(Reports, [Reports, Base]);

          expect(refusal).toBeNull();
          expect(Object.isFrozen(Middle.prototype)).toBe(false);
          expect(Object.isFrozen(Base.prototype)).toBe(false);
        });

        it("leaves a built-in, whatever the plugin's entry holds", async () => {
          @Controller("reports")
          class Reports extends Map {
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal } = await checked(Reports, [Reports, Map]);

          expect(refusal).toBeNull();
          expect(Object.isFrozen(Reports.prototype)).toBe(true);
          expect(Object.isFrozen(Map.prototype)).toBe(false);
        });

        it("refuses an instance whose base class's prototype cannot be frozen", async () => {
          // A typed array with elements cannot be frozen.
          function Base(): void {}
          const prototype = new Uint8Array(1);
          Object.setPrototypeOf(prototype, Object.prototype);
          Object.defineProperty(prototype, "constructor", { value: Base });
          Base.prototype = prototype;
          @Controller("reports")
          class Reports extends (Base as unknown as Type) {
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal } = await checked(Reports, [
            Reports,
            Base as unknown as Type,
          ]);

          expect(refusal).toContain(
            'The controller "Reports" could not be fixed to the routes and ' +
              "the class the seal read.",
          );
        });

        it("refuses an instance whose class's prototype cannot be frozen", async () => {
          // A typed array with elements cannot be frozen.
          function Reports(): void {}
          function index(): string {
            return "";
          }
          const prototype = new Uint8Array(1);
          Object.setPrototypeOf(prototype, Object.prototype);
          Object.defineProperty(prototype, "constructor", { value: Reports });
          Object.defineProperty(prototype, "index", { value: index });
          Get()(prototype, "index", { value: index });
          Reports.prototype = prototype;
          Controller("reports")(Reports);

          const { refusal } = await checked(Reports as unknown as Type);

          expect(refusal).toContain(
            'The controller "Reports" could not be fixed to the routes and ' +
              "the class the seal read.",
          );
        });

        it("leaves a method that is not a route to the prototype", async () => {
          @Controller("reports")
          class Reports {
            @Get()
            index(): string {
              return "";
            }
            helps(): boolean {
              return true;
            }
          }

          const { refusal, instance } = await checked(Reports);

          expect(refusal).toBeNull();
          expect(Object.getOwnPropertyNames(instance).sort()).toEqual([
            "constructor",
            "index",
          ]);
        });

        it("keeps the routes it fixed with the controller, for the guard", async () => {
          @Controller("reports")
          class Reports {
            @Get()
            index(): string {
              return "";
            }
            helps(): boolean {
              return true;
            }
          }
          const route = Reflect.get(Reports.prototype, "index");

          const { refusal } = await checked(Reports);

          expect(refusal).toBeNull();
          const fixed = fixedController(Reports);
          expect(fixed?.pluginId).toBe(OPTIONS.pluginId);
          expect([...(fixed?.routes.keys() ?? [])]).toEqual([route]);
        });

        it("keeps where each route is mounted and what it needs, for the guards", async () => {
          @Controller(["reports", "/summaries/"])
          @RequireCapability("memberRegister:read")
          class Reports {
            @Get()
            index(): string {
              return "";
            }
            @Post(["//monthly/", "yearly"])
            @RequireCapability("addressBook:write")
            create(): string {
              return "";
            }
            @All("any")
            any(): string {
              return "";
            }
            @Delete()
            remove(): string {
              return "";
            }
          }
          const route = (name: string): unknown =>
            fixedController(Reports)?.routes.get(
              Reflect.get(Reports.prototype, name),
            );

          const { refusal } = await checked(Reports);

          expect(refusal).toBeNull();
          expect(route("index")).toEqual({
            paths: new Set([
              "/api/plugin/occupancy/reports",
              "/api/plugin/occupancy/summaries",
            ]),
            methods: new Set(["GET", "HEAD"]),
            capabilities: ["memberRegister:read", ...OPTIONS.floor],
            residentRoute: false,
          });
          expect(route("create")).toEqual({
            paths: new Set([
              "/api/plugin/occupancy/reports//monthly",
              "/api/plugin/occupancy/reports/yearly",
              "/api/plugin/occupancy/summaries//monthly",
              "/api/plugin/occupancy/summaries/yearly",
            ]),
            methods: new Set(["POST"]),
            capabilities: [
              "addressBook:write",
              "memberRegister:read",
              ...OPTIONS.floor,
            ],
            residentRoute: false,
          });
          expect(route("any")).toMatchObject({ methods: null });
          expect(route("remove")).toMatchObject({
            methods: new Set(["DELETE"]),
          });
        });

        it("keeps nothing for a controller of the application's own", () => {
          @Controller("reports")
          class Reports {
            @Get()
            index(): string {
              return "";
            }
          }

          expect(fixedController(Reports)).toBeUndefined();
        });

        it("refuses an instance that cannot be fixed", async () => {
          @Controller("reports")
          class Reports {
            constructor() {
              Object.preventExtensions(this);
            }
            @Get()
            index(): string {
              return "";
            }
          }

          const { refusal } = await checked(Reports);

          expect(refusal).toContain(
            'The controller "Reports" could not be fixed to the routes and ' +
              "the class the seal read.",
          );
          expect(fixedController(Reports)).toBeUndefined();
        });
      });
    });

    describe("a change made before the build and undone after it", () => {
      /*
       * Wherever the plugin's code runs during the build, it can do no more
       * than change what NestJS reads and undo it before the build is over,
       * which is what these do around it.
       */
      /**
       * Built as the application builds it: the plugin's module imported by
       * a root module of the application's own, `host`, as
       * `AppModule.withPlugins` imports it.
       */
      async function undone(
        module: DynamicModule,
        change: () => () => void,
        host: Type = Harmless,
      ): Promise<string | null> {
        const sealedModule = sealed(module);
        const undo = change();
        const context = await NestFactory.createApplicationContext(
          { module: host, imports: [sealedModule] },
          { logger: false, abortOnError: false },
        );
        const modules = [...context.get(ModulesContainer).values()];
        const declared = await hostModules(declaredModules(host), context);
        await context.close();
        undo();
        expect(rereadSealedModule(sealedModule)).toBeNull();
        return sealModuleInstances(sealedModule, modules, declared);
      }

      function addedTo(target: object, key: string, value: unknown) {
        return () => {
          Reflect.defineMetadata(key, value, target);
          return () => {
            Reflect.deleteMetadata(key, target);
          };
        };
      }

      it("refuses an application-wide guard", async () => {
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(PluginModule, "providers", [GUARD]),
          ),
        ).toContain("an application-wide APP_GUARD");
      });

      it("refuses an application-wide interceptor of a request's scope", async () => {
        @Injectable({ scope: Scope.REQUEST })
        class Intercepts {
          intercept(): never {
            throw new Error("not called");
          }
        }
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(PluginModule, "providers", [
              { provide: APP_INTERCEPTOR, useClass: Intercepts },
            ]),
          ),
        ).toContain("an application-wide APP_INTERCEPTOR");
      });

      it("refuses a module made global", async () => {
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(PluginModule, GLOBAL_MODULE_METADATA, true),
          ),
        ).toContain('"PluginModule" was built global');
      });

      it("refuses an import of a module the seal never read", async () => {
        @Controller("elsewhere")
        class Elsewhere {
          @Get()
          index(): string {
            return "";
          }
        }
        @Module({ controllers: [Elsewhere] })
        class Unsealed implements NestModule {
          configure(consumer: MiddlewareConsumer): void {
            consumer.apply(() => undefined).forRoutes("*");
          }
        }
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(PluginModule, "imports", [Unsealed]),
          ),
        ).toContain(
          'importing the module "Unsealed", which the seal never read',
        );
      });

      it("refuses a global module the seal never read", async () => {
        @Global()
        @Module({ providers: [GUARD] })
        class Unsealed {}
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(PluginModule, "imports", [Unsealed]),
          ),
        ).toContain('"Unsealed", which the seal never read');
      });

      it("refuses a provider the seal did not read", async () => {
        @Injectable()
        class Extra {}
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(PluginModule, "providers", [Extra]),
          ),
        ).toContain("a provider the seal did not read");
      });

      it("refuses a controller the seal did not seal", async () => {
        @Controller("elsewhere")
        class Elsewhere {
          @Get()
          index(): string {
            return "";
          }
        }
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(PluginModule, "controllers", [Elsewhere]),
          ),
        ).toContain("a controller the seal did not seal");
      });

      it("refuses a provider given a service a plugin may not hold", async () => {
        class PrismaService {}
        @Global()
        @Module({ providers: [PrismaService], exports: [PrismaService] })
        class Database {}
        @Module({ imports: [Database] })
        class Application {}
        @Injectable()
        class Uses {
          constructor(readonly database: unknown) {}
        }
        @Module({ providers: [Uses] })
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            addedTo(Uses, SELF_DECLARED_DEPS_METADATA, [
              { index: 0, param: PrismaService },
            ]),
            Application,
          ),
        ).toContain('"PluginModule" was built with PrismaService');
      });

      it("builds the application's own modules beside the plugin's", async () => {
        class PrismaService {}
        @Global()
        @Module({ providers: [PrismaService], exports: [PrismaService] })
        class Database {}
        @Module({ imports: [Database] })
        class Application {}
        @Module({})
        class PluginModule {}

        expect(
          await undone(
            { module: PluginModule },
            () => () => undefined,
            Application,
          ),
        ).toBeNull();
      });

      /*
       * NestJS registers each dynamic module apart from its class, so one of
       * the application's classes given providers of the plugin's is a module
       * of its own, which the application never declared and the seal never
       * read, whatever its class.
       */
      describe("a module of the application's class the application did not declare", () => {
        it("refuses one given an application-wide guard", async () => {
          @Module({})
          class Shared {}
          @Module({ imports: [Shared] })
          class Application {}
          @Module({})
          class PluginModule {}

          expect(
            await undone(
              { module: PluginModule },
              addedTo(PluginModule, "imports", [
                { module: Shared, providers: [GUARD] },
              ]),
              Application,
            ),
          ).toContain(
            'importing the module "Shared", which the seal never read',
          );
        });

        it("refuses one made global", async () => {
          @Module({})
          class Shared {}
          @Module({ imports: [Shared] })
          class Application {}
          @Module({})
          class PluginModule {}

          expect(
            await undone(
              { module: PluginModule },
              addedTo(PluginModule, "imports", [
                { module: Shared, global: true, providers: [GUARD] },
              ]),
              Application,
            ),
          ).toContain('"Shared", which the seal never read');
        });

        it("refuses one of NestJS's own core module", async () => {
          @Module({})
          class PluginModule {}

          expect(
            await undone(
              { module: PluginModule },
              addedTo(PluginModule, "imports", [
                { module: InternalCoreModule, providers: [GUARD] },
              ]),
            ),
          ).toContain('"InternalCoreModule", which the seal never read');
        });

        it("refuses one beside a dynamic module the application declares", async () => {
          @Module({})
          class Shared {}
          @Module({ imports: [{ module: Shared, providers: [] }] })
          class Application {}
          @Module({})
          class PluginModule {}

          expect(
            await undone(
              { module: PluginModule },
              addedTo(PluginModule, "imports", [
                { module: Shared, providers: [GUARD] },
              ]),
              Application,
            ),
          ).toContain(
            'importing the module "Shared", which the seal never read',
          );
        });
      });

      describe("the application's own modules a plugin imports", () => {
        it("builds a module the application declares as its class", async () => {
          @Module({})
          class Shared {}
          @Module({ imports: [Shared] })
          class Application {}
          @Module({})
          class PluginModule {}

          expect(
            await undone(
              { module: PluginModule, imports: [Shared] },
              () => () => undefined,
              Application,
            ),
          ).toBeNull();
        });

        it("builds a dynamic module the application declares", async () => {
          @Module({})
          class Shared {}
          const declared = { module: Shared, providers: [] };
          @Module({ imports: [declared] })
          class Application {}
          @Module({})
          class PluginModule {}

          expect(
            await undone(
              { module: PluginModule, imports: [declared] },
              () => () => undefined,
              Application,
            ),
          ).toBeNull();
        });

        it("builds a dynamic module of an application class the seal read", async () => {
          @Injectable()
          class Local {}
          @Module({})
          class Shared {}
          @Module({ imports: [Shared] })
          class Application {}
          @Module({})
          class PluginModule {}

          expect(
            await undone(
              {
                module: PluginModule,
                imports: [{ module: Shared, providers: [Local] }],
              },
              () => () => undefined,
              Application,
            ),
          ).toBeNull();
        });

        it("refuses a provider added to a dynamic module of an application class the seal read", async () => {
          @Injectable()
          class Local {}
          @Module({})
          class Shared {}
          @Module({ imports: [Shared] })
          class Application {}
          @Module({})
          class PluginModule {}
          const imported = { module: Shared, providers: [Local] };

          expect(
            await undone(
              { module: PluginModule, imports: [imported] },
              addedTo(Shared, "providers", [GUARD]),
              Application,
            ),
          ).toContain('"Shared" was built with an application-wide APP_GUARD');
        });
      });
    });
  });

  it("takes no module for the application's own where the container cannot be read", async () => {
    expect(
      await hostModules([Harmless], {} as INestApplicationContext),
    ).toEqual(new Set());
  });
});

/**
 * The tokens that are not classes, and the handles that resolve any of them.
 *
 * The matcher read `typeof reached === "function"` and then `reached.name`, so
 * a token that is a symbol or a string could never match however the denylist
 * was spelled - which is to say that `ENV` and `PROTECTED_RESOURCE` were
 * inexpressible rather than merely absent. And a plugin that declares
 * `ModuleRef` reaches every other name on the list without naming one of them.
 */
describe("the tokens a name check could not see", () => {
  it("refuses a symbol token by its description", () => {
    // ENV is Symbol("OPENBRF_ENV"): the instance's whole configuration,
    // secrets included. The description is the only thing a symbol carries.
    const ENV = Symbol("OPENBRF_ENV");
    @Injectable()
    class Sneaky {
      constructor(@Inject(ENV) private readonly env: unknown) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Sneaky] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("OPENBRF_ENV");
  });

  it("refuses a string token as the string it is", () => {
    @Injectable()
    class Sneaky {
      constructor(
        @Inject("PROTECTED_RESOURCE") private readonly resource: unknown,
      ) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Sneaky] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("PROTECTED_RESOURCE");
  });

  it("leaves a symbol of the plugin's own alone", () => {
    // A plugin naming its own providers with symbols is ordinary NestJS.
    const OWN = Symbol("plugin.own.config");
    @Injectable()
    class Ordinary {
      constructor(@Inject(OWN) private readonly own: unknown) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Ordinary] },
      OPTIONS,
    );

    expect(result.ok).toBe(true);
  });

  it("refuses the injector handle that would resolve any of the rest", () => {
    // moduleRef.get(PrismaService, { strict: false }) is precisely the reach a
    // declaration check cannot see, and @nestjs/core is a host-shared package
    // whose resolution identity the loader asserts.
    class ModuleRef {}
    @Injectable()
    class Sneaky {
      constructor(private readonly modules: ModuleRef) {}
    }
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Sneaky] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain("ModuleRef");
  });
});

/**
 * The seven names the old six-name list left reachable.
 *
 * Three of them are services the host deliberately wraps before it hands them
 * over, which is what makes this more than tidiness: a plugin holding the
 * mailer directly gets neither the mail:send permission the board consented to
 * nor the template stamped with its own id, and can mail every member through
 * the association's own templates.
 */
describe("what a global module exports and a plugin may not hold", () => {
  it.each([
    ["MailService"],
    ["SmsService"],
    ["JobQueueService"],
    ["FieldEncryptionService"],
    ["CatalogClient"],
    ["I18nService"],
    ["AuthorizationGuard"],
  ])("refuses a provider constructed with %s", (name) => {
    const Reached = { [name]: class {} }[name] as Type<unknown>;
    @Injectable()
    class Sneaky {
      constructor(private readonly reached: unknown) {}
    }
    Reflect.defineMetadata("design:paramtypes", [Reached], Sneaky);
    @Module({})
    class PluginModule {}

    const result = sealPluginModule(
      { module: PluginModule, providers: [Sneaky] },
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("forbidden-injection");
    expect(result.ok ? "" : result.log).toContain(name);
  });
});

/**
 * The classification itself, as a constant a reviewer reads rather than runs.
 *
 * `scripts/check-plugin-injections.mjs` reads the same two structures out of
 * the source and refuses a `@Global()` export that appears in neither, so what
 * is left to assert here is that the two lists agree with each other and that
 * every denial carries the sentence a reviewer needs to check it against the
 * decision.
 */
describe("the classification the seal is written from", () => {
  it("classifies no provider both ways", () => {
    // A name on both lists is a contradiction rather than a preference, and the
    // guard script would read it as classified and say nothing.
    for (const denied of DENIED_INJECTIONS) {
      expect(
        ALLOWED_INJECTIONS.has(denied.token),
        `${denied.token} is both denied and allowed`,
      ).toBe(false);
    }
  });

  it("says why each provider is denied", () => {
    for (const denied of DENIED_INJECTIONS) {
      expect(denied.token, "a denied entry names no token").not.toBe("");
      expect(
        denied.why.length,
        `${denied.token} is denied without a reason`,
      ).toBeGreaterThan(20);
    }
  });

  it("names each provider once", () => {
    const tokens = DENIED_INJECTIONS.map((denied) => denied.token);
    expect(new Set(tokens).size, "a provider is denied twice").toBe(
      tokens.length,
    );
  });
});

/**
 * A plugin's routes under one of its device routes (ADR 0031).
 *
 * A device route is reached with a credential no person holds, and a device
 * reads. A route the plugin could answer a write on there would be a write
 * reachable with a token unscrewed from a wall, so the seal refuses the plugin
 * rather than letting the guard be the only thing between the two.
 */
describe("a route under a device route", () => {
  const DEVICE_OPTIONS = {
    ...OPTIONS,
    floor: ["self:manage"],
    deviceRoutes: ["/api/plugin/occupancy/screen"],
  } as const;

  function sealWithDeviceRoute(controller: Type) {
    @Module({})
    class PluginModule {}
    return sealPluginModule(
      { module: PluginModule, controllers: [controller] },
      DEVICE_OPTIONS,
    );
  }

  it("lets a plugin answer GET under it, and HEAD with it", () => {
    @Controller("screen")
    class Screen {
      @Get("content")
      content(): string {
        return "";
      }
    }

    expect(sealWithDeviceRoute(Screen).ok).toBe(true);
  });

  it("refuses a plugin that answers a write under it, naming the route", () => {
    @Controller("screen")
    class Screen {
      @Post("content")
      content(): string {
        return "";
      }
    }

    const sealed = sealWithDeviceRoute(Screen);
    expect(sealed).toMatchObject({ ok: false, reason: "module-refused" });
    expect(!sealed.ok && sealed.log).toContain("POST");
    expect(!sealed.ok && sealed.log).toContain("/api/plugin/occupancy/screen");
  });

  it("refuses a route mounted for every method", () => {
    @Controller("screen")
    class Screen {
      @All()
      any(): string {
        return "";
      }
    }

    expect(sealWithDeviceRoute(Screen)).toMatchObject({
      ok: false,
      reason: "module-refused",
    });
  });

  it("refuses a write a parameter segment could put there", () => {
    // `DELETE /:id` on the mount answers `DELETE /screen` as well.
    @Controller()
    class Items {
      @Delete(":id")
      remove(): string {
        return "";
      }
    }

    expect(sealWithDeviceRoute(Items)).toMatchObject({
      ok: false,
      reason: "module-refused",
    });
  });

  it("leaves a write beside it alone", () => {
    @Controller("screens")
    class Screens {
      @Post()
      create(): string {
        return "";
      }
    }

    expect(sealWithDeviceRoute(Screens).ok).toBe(true);
  });
});

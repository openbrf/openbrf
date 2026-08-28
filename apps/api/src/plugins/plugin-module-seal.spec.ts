import {
  type CanActivate,
  Controller,
  type DynamicModule,
  Get,
  Global,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Post,
} from "@nestjs/common";
import { HOST_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { PLUGIN_ID_METADATA, sealPluginModule } from "./plugin-module-seal";

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

const OPTIONS = { pluginId: "occupancy", floor: "addressBook:read" } as const;

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
          { pluginId: "other", floor: "self:manage" },
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
  });
});

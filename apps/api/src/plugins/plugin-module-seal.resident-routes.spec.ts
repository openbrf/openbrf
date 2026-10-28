import {
  type ArgumentMetadata,
  Body,
  type CallHandler,
  type CanActivate,
  Catch,
  Controller,
  createParamDecorator,
  type DynamicModule,
  type ExceptionFilter,
  Get,
  Header,
  HttpCode,
  Injectable,
  Module,
  type NestInterceptor,
  Next,
  Param,
  type PipeTransform,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  type Type,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from "@nestjs/common";
import {
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  REDIRECT_METADATA,
} from "@nestjs/common/constants";
import { ModulesContainer, NestFactory } from "@nestjs/core";
import type { Observable } from "rxjs";
import { describe, expect, it } from "vite-plus/test";

import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type CheckedRoute,
  fixedController,
  hostModules,
  pluginRoutePath,
  type SealOptions,
  sealModuleInstances,
  sealPluginModule,
} from "./plugin-module-seal";
import { runOnResidentRoute } from "./resident-route-scope";

/**
 * What the seal does with a plugin's resident routes (ADR 0051).
 *
 * A route under one is held to `self:manage` instead of the address-book half
 * of the floor, decided per handler by containment, and the plugin's own code
 * around such a handler - a guard, an interceptor, a pipe, an exception filter
 * or a custom parameter decorator - refuses the plugin at load, because it
 * would run outside the scope the route is served in. What the router mounts
 * the route with is read from the built controller, as the guards read it.
 */

const PLUGIN = "parking-share";
const OPTIONS: SealOptions = {
  pluginId: PLUGIN,
  floor: ["addressBook:read"],
  residentRoutes: [pluginRoutePath(PLUGIN, "offers")],
  source: "",
};

function moduleOf(controllers: Type[]): DynamicModule {
  @Module({})
  class PluginModule {}
  return { module: PluginModule, controllers };
}

/**
 * Seals the controllers and builds them, and gives each route the guards would
 * read, by method name, or the seal's refusal.
 */
async function sealed(
  controllers: Type[],
  options: SealOptions = OPTIONS,
): Promise<
  | {
      ok: true;
      routes: Map<string, CheckedRoute>;
      instances: Map<Type, Record<string, unknown>>;
    }
  | { ok: false; log: string }
> {
  const result = sealPluginModule(moduleOf(controllers), options);
  if (!result.ok) {
    return { ok: false, log: result.log };
  }
  const context = await NestFactory.createApplicationContext(result.module, {
    logger: false,
    abortOnError: false,
  });
  const modules = [...context.get(ModulesContainer).values()];
  const host = await hostModules([], context);
  await context.close();
  const refusal = sealModuleInstances(result.module, modules, host);
  if (refusal !== null) {
    return { ok: false, log: refusal };
  }
  const routes = new Map<string, CheckedRoute>();
  const instances = new Map<Type, Record<string, unknown>>();
  for (const controller of controllers) {
    const instance = modules
      .flatMap((module) => [...module.controllers])
      .find(([token]) => token === controller)?.[1].instance as Record<
      string,
      unknown
    >;
    instances.set(controller, instance);
    for (const [method, checked] of fixedController(controller)?.routes ?? []) {
      const name = Object.getOwnPropertyNames(instance).find(
        (key) => instance[key] === method,
      );
      if (name !== undefined) {
        routes.set(name, checked);
      }
    }
  }
  return { ok: true, routes, instances };
}

async function routesOf(
  controllers: Type[],
  options?: SealOptions,
): Promise<Map<string, CheckedRoute>> {
  const result = await sealed(controllers, options);
  if (!result.ok) {
    throw new Error(`The seal refused the plugin: ${result.log}`);
  }
  return result.routes;
}

async function refusalOf(controllers: Type[]): Promise<string> {
  const result = await sealed(controllers);
  if (result.ok) {
    throw new Error("The seal let the plugin through.");
  }
  return result.log;
}

describe("which routes are under a resident route", () => {
  it.each([
    ["the resident route itself", "offers", ""],
    ["a path below it", "offers", "today"],
    ["a parameter below it", "offers", ":id"],
    ["a wildcard below it", "offers", "*"],
    ["a parameter with a pattern below it", "offers", ":id(\\d+)"],
  ])("holds %s to self:manage", async (_case, controllerPath, path) => {
    @Controller(controllerPath)
    class Offers {
      @Get(path)
      read(): string {
        return "";
      }
    }

    const route = (await routesOf([Offers])).get("read");

    expect(route).toMatchObject({
      residentRoute: true,
      capabilities: ["self:manage"],
    });
  });

  it.each([
    ["a parameter where the route is", "", ":id"],
    ["a wildcard within its segment", "", "off*"],
    ["a wildcard after its segment", "", "offers*"],
    ["a parameter with a pattern where the route is", "", ":what(offers)"],
    ["an optional parameter where the route is", "", ":offers?"],
    ["the escape for a literal colon", "", "offers::x"],
    ["a segment that starts the same", "", "offers-old"],
    ["an empty segment before it", "", "/x//offers"],
    ["another spelling of it", "", "Offers"],
    ["the plugin's mount", "", ""],
    ["a sibling path", "claims", ""],
  ])("keeps %s at the full floor", async (_case, controllerPath, path) => {
    @Controller(controllerPath)
    class Elsewhere {
      @Get(path)
      read(): string {
        return "";
      }
    }

    const route = (await routesOf([Elsewhere])).get("read");

    expect(route).toMatchObject({
      residentRoute: false,
      capabilities: ["addressBook:read"],
    });
  });

  it("keeps a route mounted under it and anywhere else at the full floor", async () => {
    @Controller(["offers", "board"])
    class Both {
      @Get()
      read(): string {
        return "";
      }
    }

    expect((await routesOf([Both])).get("read")).toMatchObject({
      residentRoute: false,
      capabilities: ["addressBook:read"],
    });
  });

  it("decides per handler, so a controller may hold both kinds", async () => {
    @Controller()
    class Mixed {
      @Get("offers/mine")
      mine(): string {
        return "";
      }
      @Get("board/all")
      all(): string {
        return "";
      }
    }

    const routes = await routesOf([Mixed]);

    expect(routes.get("mine")).toMatchObject({
      residentRoute: true,
      capabilities: ["self:manage"],
    });
    expect(routes.get("all")).toMatchObject({
      residentRoute: false,
      capabilities: ["addressBook:read"],
    });
  });

  it("keeps what a route asks for itself, and what its controller asks for", async () => {
    @Controller("offers")
    @RequireCapability("bookings:book")
    class Offers {
      @Post()
      @RequireCapability("bookings:configure")
      create(): string {
        return "";
      }
    }

    expect((await routesOf([Offers])).get("create")).toMatchObject({
      residentRoute: true,
      capabilities: ["bookings:configure", "bookings:book", "self:manage"],
    });
  });

  it("lowers only the address-book half of an extension group's floor (ADR 0052)", async () => {
    @Controller("offers")
    class Offers {
      @Get()
      read(): string {
        return "";
      }
    }

    const route = (
      await routesOf([Offers], {
        ...OPTIONS,
        floor: ["addressBook:read", "fees:manage", "memberCharges:manage"],
      })
    ).get("read");

    expect(route).toMatchObject({
      residentRoute: true,
      capabilities: ["fees:manage", "memberCharges:manage"],
    });
  });

  it("lowers nothing for a plugin that declares no resident routes", async () => {
    @Controller("offers")
    class Offers {
      @Get()
      read(): string {
        return "";
      }
    }

    const route = (
      await routesOf([Offers], { ...OPTIONS, residentRoutes: [] })
    ).get("read");

    expect(route).toMatchObject({
      residentRoute: false,
      capabilities: ["addressBook:read"],
    });
  });
});

@Injectable()
class PluginGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
class PluginInterceptor implements NestInterceptor {
  intercept(_context: unknown, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

@Injectable()
class PluginPipe implements PipeTransform {
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return value;
  }
}

@Catch()
class PluginFilter implements ExceptionFilter {
  catch(): void {}
}

const Caller = createParamDecorator(() => "the caller");

describe("the plugin's code around a resident route's handler", () => {
  it.each([
    ["a guard", UseGuards(PluginGuard), "a guard"],
    ["an interceptor", UseInterceptors(PluginInterceptor), "an interceptor"],
    ["a pipe", UsePipes(PluginPipe), "a pipe"],
    ["an exception filter", UseFilters(PluginFilter), "an exception filter"],
  ])(
    "refuses %s named on the handler",
    async (_kind, decorator: MethodDecorator & ClassDecorator, named) => {
      @Controller("offers")
      class Offers {
        @Get()
        @decorator
        read(): string {
          return "";
        }
      }

      expect(await refusalOf([Offers])).toContain(`it names ${named}`);
    },
  );

  it.each([
    ["a guard", UseGuards(PluginGuard), "a guard"],
    ["an interceptor", UseInterceptors(PluginInterceptor), "an interceptor"],
    ["a pipe", UsePipes(PluginPipe), "a pipe"],
    ["an exception filter", UseFilters(PluginFilter), "an exception filter"],
  ])(
    "refuses %s named on its controller",
    async (_kind, decorator: MethodDecorator & ClassDecorator, named) => {
      @Controller("offers")
      @decorator
      class Offers {
        @Get()
        read(): string {
          return "";
        }
      }

      expect(await refusalOf([Offers])).toContain(
        `its controller names ${named}`,
      );
    },
  );

  it("refuses an enhancer its controller inherits from a base class", async () => {
    @UseGuards(PluginGuard)
    class Base {}
    @Controller("offers")
    class Offers extends Base {
      @Get()
      read(): string {
        return "";
      }
    }

    expect(await refusalOf([Offers])).toContain("its controller names a guard");
  });

  it("refuses a pipe on a parameter", async () => {
    @Controller("offers")
    class Offers {
      @Post()
      create(@Body(PluginPipe) body: unknown): unknown {
        return body;
      }
    }

    expect(await refusalOf([Offers])).toContain("it gives a parameter a pipe");
  });

  it("refuses a custom parameter decorator on the handler", async () => {
    @Controller("offers")
    class Offers {
      @Get()
      read(@Caller() caller: unknown): unknown {
        return caller;
      }
    }

    expect(await refusalOf([Offers])).toContain(
      "it takes a parameter through a custom parameter decorator",
    );
  });

  it("refuses a custom parameter decorator on a handler inherited from a base class", async () => {
    class Base {
      @Get()
      read(@Caller() caller: unknown): unknown {
        return caller;
      }
    }
    @Controller("offers")
    class Offers extends Base {}

    expect(await refusalOf([Offers])).toContain(
      "it takes a parameter through a custom parameter decorator",
    );
  });

  it("refuses a custom parameter decorator a handler's override inherits", async () => {
    // NestJS reads the parameters a base class declared under the same name.
    class Base {
      read(@Caller() caller: unknown): unknown {
        return caller;
      }
    }
    @Controller("offers")
    class Offers extends Base {
      @Get()
      override read(caller: unknown): unknown {
        return caller;
      }
    }

    expect(await refusalOf([Offers])).toContain(
      "it takes a parameter through a custom parameter decorator",
    );
  });

  it.each([
    ["@Res", Res()],
    ["@Res with passthrough", Res({ passthrough: true })],
    ["@Next", Next()],
  ])(
    "refuses a handler handed the response through %s",
    async (_kind, take) => {
      @Controller("offers")
      class Offers {
        @Get()
        read(@Req() request: unknown, @take reply: unknown): unknown {
          return [request, reply];
        }
      }

      expect(await refusalOf([Offers])).toContain(
        "it is handed the response, through `@Res` or `@Next`",
      );
    },
  );

  it("keeps the framework's own parameter decorators", async () => {
    @Controller("offers")
    class Offers {
      @Post(":id")
      create(
        @Req() request: unknown,
        @Param("id") id: string,
        @Query("day") day: string,
        @Body() body: unknown,
      ): unknown {
        return [request, id, day, body];
      }
    }

    expect((await routesOf([Offers])).get("create")).toMatchObject({
      residentRoute: true,
    });
  });

  it("leaves the plugin's code on a route outside the resident routes alone", async () => {
    @Controller()
    class Mixed {
      @Get("offers/mine")
      mine(): string {
        return "";
      }
      @Get("board/all")
      @UseGuards(PluginGuard)
      all(@Caller() caller: unknown): unknown {
        return caller;
      }
      @Get("board/headed")
      @Header("x-offer", () => "computed")
      headed(): string {
        return "";
      }
    }

    const routes = await routesOf([Mixed]);

    expect(routes.get("mine")).toMatchObject({ residentRoute: true });
    expect(routes.get("all")).toMatchObject({ residentRoute: false });
    expect(routes.get("headed")).toMatchObject({ residentRoute: false });
  });
});

/**
 * NestJS sets a route's status code and headers before the interceptors run,
 * so before the resident route's scope is open, and Fastify runs a header
 * name's `toLowerCase` and a status code's `valueOf`. What it would run of the
 * plugin's there refuses the plugin at load.
 */
describe("what NestJS answers a resident route with", () => {
  /** A resident route's handler with `decorator` applied, as a class. */
  function decorated(decorator: MethodDecorator): Type {
    @Controller("offers")
    class Offers {
      @Get()
      @decorator
      read(): string {
        return "";
      }
    }
    return Offers;
  }

  /** Metadata written as a decorator would write it, but with `value`. */
  function metadata(key: string, value: unknown): MethodDecorator {
    return (_target, _key, descriptor) => {
      Reflect.defineMetadata(key, value, descriptor.value as object);
      return descriptor;
    };
  }

  const shouting = {
    toLowerCase() {
      return "x-offer";
    },
  };
  const counted = {
    valueOf() {
      return 200;
    },
  };

  it.each([
    ["a header value the plugin computes", Header("x-offer", () => "computed")],
    [
      "a header name of the plugin's own kind",
      Header(shouting as unknown as string, "x"),
    ],
    [
      "a header value read through a getter",
      metadata(HEADERS_METADATA, [
        {
          name: "x-offer",
          get value() {
            return "x";
          },
        },
      ]),
    ],
    [
      "a header held by a proxy",
      metadata(HEADERS_METADATA, [
        new Proxy({ name: "x-offer", value: "x" }, {}),
      ]),
    ],
  ])("refuses %s", async (_kind, decorator) => {
    expect(await refusalOf([decorated(decorator)])).toContain(
      "it sets a response header to something other than text",
    );
  });

  it.each([
    ["an object", metadata(HTTP_CODE_METADATA, counted)],
    ["a fraction", HttpCode(200.5)],
    ["below 100", HttpCode(0)],
    ["above 599", HttpCode(600)],
  ])("refuses a status code that is %s", async (_kind, decorator) => {
    expect(await refusalOf([decorated(decorator)])).toContain(
      "it answers with a status code that is not a whole number from 100 to 599",
    );
  });

  it.each([
    ["a status code of the plugin's own kind", Redirect("/", counted as never)],
    ["a status code of 600", Redirect("/", 600)],
    ["a status code of 99", Redirect("/", 99)],
    [
      "an address read through a getter",
      metadata(REDIRECT_METADATA, {
        get url() {
          return "/";
        },
      }),
    ],
  ])("refuses a redirect with %s", async (_kind, decorator) => {
    expect(await refusalOf([decorated(decorator)])).toContain(
      "it redirects to something other than an address and a status code",
    );
  });

  it("keeps text headers, a status code and a redirect, fixed as they were checked", async () => {
    @Controller("offers")
    class Offers {
      @Post()
      @HttpCode(202)
      @Header("cache-control", "no-store")
      create(): string {
        return "";
      }
      @Get("away")
      @Redirect("/app", 303)
      away(): string {
        return "";
      }
    }
    const routes = await routesOf([Offers]);
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      Reflect.get(Offers.prototype, "create") as object,
    ) as { name: string; value: string }[];
    const redirect = Reflect.getMetadata(
      REDIRECT_METADATA,
      Reflect.get(Offers.prototype, "away") as object,
    ) as object;

    expect(routes.get("create")).toMatchObject({ residentRoute: true });
    expect(routes.get("away")).toMatchObject({ residentRoute: true });
    expect(headers).toEqual([{ name: "cache-control", value: "no-store" }]);
    expect(Object.isFrozen(headers)).toBe(true);
    expect(headers.every((header) => Object.isFrozen(header))).toBe(true);
    expect(Object.isFrozen(redirect)).toBe(true);
  });
});

describe("the method a resident route is mounted with", () => {
  it("is the host's wrapper round the plugin's, with its metadata, and known to the guards by it", async () => {
    @Controller()
    class Offers {
      @Post("offers")
      @HttpCode(202)
      create(): string {
        return "created";
      }
      @Get("board")
      board(): string {
        return "";
      }
    }
    const own = Reflect.get(Offers.prototype, "create") as object;

    const result = await sealed([Offers]);
    if (!result.ok) {
      throw new Error(result.log);
    }
    const instance = result.instances.get(Offers) ?? {};
    const mounted = instance["create"] as (...args: unknown[]) => unknown;

    expect(mounted).not.toBe(own);
    expect(mounted.name).toBe("create");
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, mounted)).toBe(202);
    expect(fixedController(Offers)?.routes.get(mounted)).toMatchObject({
      residentRoute: true,
    });
    expect(fixedController(Offers)?.routes.has(own)).toBe(false);
    expect(
      runOnResidentRoute(
        { pluginId: PLUGIN, request: {}, personId: "person-1" },
        () => mounted.call(instance),
      ),
    ).toBe("created");
    // A route outside the resident routes is mounted with the plugin's own.
    expect(instance["board"]).toBe(Reflect.get(Offers.prototype, "board"));
  });
});

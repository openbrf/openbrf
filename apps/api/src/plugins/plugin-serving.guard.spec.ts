import {
  Controller,
  type ExecutionContext,
  Get,
  Module,
  type Type,
} from "@nestjs/common";
import { ModulesContainer, NestFactory, Reflector } from "@nestjs/core";
import { describe, expect, it } from "vite-plus/test";

import type { PluginLoaderService } from "./plugin-loader.service";
import {
  hostModules,
  PLUGIN_ID_METADATA,
  sealModuleInstances,
  sealPluginModule,
} from "./plugin-module-seal";
import { PluginServingGuard } from "./plugin-serving.guard";
import { PluginNotFoundError } from "./plugin.errors";

/**
 * The guard in front of every plugin route.
 *
 * It answers a disabled plugin's routes as not installed, and it lets a
 * request reach a plugin's controller only under a route the controller's
 * instance was fixed to once it was checked. NestJS mounts the routes after
 * that check, from whatever the controller holds by then, so a method that
 * became a route afterwards is mounted all the same; this is what keeps it
 * from being served.
 */

const PLUGIN_ID = "occupancy";

/** Seals a plugin's controller and checks what NestJS built, as a boot does. */
async function fixed(controller: Type): Promise<void> {
  @Module({})
  class PluginModule {}
  const sealed = sealPluginModule(
    { module: PluginModule, controllers: [controller] },
    { pluginId: PLUGIN_ID, floor: "addressBook:read" },
  );
  if (!sealed.ok) {
    throw new Error(`The module was refused: ${sealed.log}`);
  }
  const context = await NestFactory.createApplicationContext(sealed.module, {
    logger: false,
    abortOnError: false,
  });
  const modules = [...context.get(ModulesContainer).values()];
  const host = await hostModules([], context);
  await context.close();
  const refusal = sealModuleInstances(sealed.module, modules, host);
  if (refusal !== null) {
    throw new Error(`The build was refused: ${refusal}`);
  }
}

function guard(enabled = true): PluginServingGuard {
  const loader = {
    get: (id: string) => (enabled && id === PLUGIN_ID ? {} : null),
  };
  return new PluginServingGuard(
    new Reflector(),
    loader as unknown as PluginLoaderService,
  );
}

function request(controller: Type, handler: unknown): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

/** A plugin controller with one route and one method that is not a route. */
function reports(): Type {
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
  return Reports;
}

describe("the plugin serving guard", () => {
  it("lets a route of the application's own through", () => {
    @Controller("own")
    class Own {
      @Get()
      index(): string {
        return "";
      }
    }

    expect(
      guard().canActivate(request(Own, Reflect.get(Own.prototype, "index"))),
    ).toBe(true);
  });

  it("lets a route the plugin was checked with through", async () => {
    const controller = reports();
    await fixed(controller);

    expect(
      guard().canActivate(
        request(controller, Reflect.get(controller.prototype, "index")),
      ),
    ).toBe(true);
  });

  it("answers a disabled plugin's route as not installed", async () => {
    const controller = reports();
    await fixed(controller);

    expect(() =>
      guard(false).canActivate(
        request(controller, Reflect.get(controller.prototype, "index")),
      ),
    ).toThrow(PluginNotFoundError);
  });

  it("answers a method added as a route after the check as not installed", async () => {
    const controller = reports();
    await fixed(controller);
    function added(): string {
      return "added";
    }
    Object.defineProperty(controller.prototype, "added", { value: added });
    Get("added")(controller.prototype, "added", { value: added });

    expect(() => guard().canActivate(request(controller, added))).toThrow(
      PluginNotFoundError,
    );
  });

  it("answers a method made a route after the check as not installed", async () => {
    const controller = reports();
    await fixed(controller);
    const helps: unknown = Reflect.get(controller.prototype, "helps");
    Get("helps")(controller.prototype, "helps", { value: helps });

    expect(() => guard().canActivate(request(controller, helps))).toThrow(
      PluginNotFoundError,
    );
  });

  it("holds a controller to its plugin whatever its marker says afterwards", async () => {
    const controller = reports();
    await fixed(controller);
    Reflect.defineMetadata(PLUGIN_ID_METADATA, undefined, controller);

    expect(() =>
      guard().canActivate(
        request(controller, Reflect.get(controller.prototype, "helps")),
      ),
    ).toThrow(PluginNotFoundError);
  });

  it("answers a plugin's controller whose instance was never fixed as not installed", () => {
    const controller = reports();
    Reflect.defineMetadata(PLUGIN_ID_METADATA, PLUGIN_ID, controller);

    expect(() =>
      guard().canActivate(
        request(controller, Reflect.get(controller.prototype, "index")),
      ),
    ).toThrow(PluginNotFoundError);
  });
});

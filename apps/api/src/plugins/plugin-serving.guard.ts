import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { PluginLoaderService } from "./plugin-loader.service";
import { fixedController, PLUGIN_ID_METADATA } from "./plugin-module-seal";
import { PluginNotFoundError } from "./plugin.errors";

/**
 * Keeps a plugin's routes answering only while the plugin is switched on, and
 * only on the routes its module was checked with.
 *
 * A plugin contributes real NestJS controllers, and NestJS has no way to
 * remove a route from a running router. This is what makes disabling bite
 * immediately anyway: the route stays registered and answers as though the
 * plugin were not installed at all.
 *
 * Registered globally so it covers every plugin controller without a plugin
 * having to opt in, and it lets every other route through untouched - the
 * marker it looks for is put on a controller by the host when the plugin's
 * module is sealed, and there is no way for a plugin to write it itself.
 *
 * A request is let through only to the method of a route the controller's
 * instance was fixed to (`fixedController`) while the plugin is enabled. Any
 * other method of a plugin's controller is answered as not installed, as is a
 * controller marked as a plugin's whose instance was never fixed.
 *
 * A disabled plugin is answered as not installed rather than as forbidden, on
 * purpose: which plugins an instance has is not something an arbitrary
 * signed-in account needs to be able to probe.
 */
@Injectable()
export class PluginServingGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly loader: PluginLoaderService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const controller = context.getClass();
    const fixed = fixedController(controller);
    const pluginId =
      fixed?.pluginId ??
      this.reflector.get<string | undefined>(PLUGIN_ID_METADATA, controller);
    if (pluginId === undefined) {
      return true;
    }
    if (
      fixed === undefined ||
      !fixed.routes.has(context.getHandler()) ||
      this.loader.get(pluginId) === null
    ) {
      throw new PluginNotFoundError(pluginId);
    }
    return true;
  }
}

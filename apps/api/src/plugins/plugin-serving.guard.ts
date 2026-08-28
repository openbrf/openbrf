import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { PluginLoaderService } from "./plugin-loader.service";
import { PLUGIN_ID_METADATA } from "./plugin-module-seal";
import { PluginNotFoundError } from "./plugin.errors";

/**
 * Keeps a plugin's routes answering only while the plugin is switched on.
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
    const pluginId = this.reflector.get<string | undefined>(
      PLUGIN_ID_METADATA,
      context.getClass(),
    );
    if (pluginId === undefined) {
      return true;
    }
    if (this.loader.get(pluginId) === null) {
      throw new PluginNotFoundError(pluginId);
    }
    return true;
  }
}

import type { DynamicModule } from "@nestjs/common";

import type { PluginHost } from "./host.ts";

/**
 * What a plugin's server entry point returns.
 *
 * A plugin's backend is a NestJS module. Its controllers, providers, guards,
 * interceptors and lifecycle hooks are the framework's own and behave exactly
 * as they do in the application itself, which is what lets a plugin be written
 * the way any NestJS code is written rather than against a second, narrower
 * interface that has to grow a feature at a time.
 *
 * The host registers the module in the application's graph while the process
 * starts, so the plugin's controllers are part of the router the application
 * builds. Four things the host does to that module are not negotiable, and a
 * plugin cannot opt out of any of them:
 *
 *   Its controllers are mounted under `/api/plugin/<id>/`. A path a controller
 *   declares is relative to that prefix, whatever it says.
 *
 *   Its routes sit inside the application's own authorization guard, with the
 *   capability each one requires raised to the floor the plugin's declared
 *   permissions imply. A plugin cannot mark a route public.
 *
 *   Its module may not register application-wide behaviour: a global guard,
 *   interceptor, filter or pipe, middleware, or a `@Global()` module. Those
 *   would apply to the core's routes as well as its own.
 *
 *   Its routes stop answering the moment the board switches the plugin off,
 *   without waiting for a restart.
 *
 * A module that breaks one of the last two is refused at load and reported on
 * the admin screen, the same way a malformed manifest is.
 */
export type PluginModuleFactory = (
  host: PluginHost,
) => DynamicModule | Promise<DynamicModule>;

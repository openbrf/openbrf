import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";
import { type Env, loadEnv } from "./config/env";
import { loadNearestEnvFile } from "./config/load-env-file";
import { processRole } from "./config/process-role";
import {
  type BootPlugin,
  loadPlugins,
  type PluginBoot,
  readPluginRecords,
  setPluginBoot,
} from "./plugins/plugin-boot";
import {
  type PluginHostBinding,
  pluginHostBinding,
} from "./plugins/plugin-host";
import { PluginHostBinder } from "./plugins/plugin-host.binder";

/**
 * Starting the application with its installed plugins.
 *
 * The order below is the whole of ADR 0003's boot sequence and none of it is
 * incidental:
 *
 *   Module resolution is bridged first, because a plugin's CommonJS bundle can
 *   otherwise resolve nothing from the host - CJS resolution walks up from
 *   /data/plugins and never reaches the application's node_modules.
 *
 *   The plugins are loaded next, before the application is built, because a
 *   plugin contributes a NestJS module and NestJS registers controllers only
 *   for the modules present when the container is built. Installing a plugin
 *   ends by replacing the process, so this is not an early moment for loading
 *   one - it is the only moment there is.
 *
 *   The host objects are bound after the container is built and before it is
 *   initialised. That is the one window in which every provider exists and no
 *   plugin lifecycle hook or request handler has run yet.
 *
 * Shared with the integration suite rather than written twice: the sequence is
 * the thing under test, and a test that assembled its own would be testing
 * something else.
 */

/** Loads the environment the way the application's own ConfigModule does. */
export function loadBootEnv(): Env {
  loadNearestEnvFile();
  return loadEnv();
}

/**
 * Reads the data volume and returns what should be in the application's graph.
 *
 * The database is only consulted when there is something to consult it about.
 * Plugins switched off for the instance, and the command-line process which
 * must never execute plugin code, both stop here.
 */
export async function loadPluginsAtBoot(
  env: Env,
  binding: PluginHostBinding = pluginHostBinding,
): Promise<PluginBoot> {
  const skip = !env.OPENBRF_PLUGINS_ENABLED || processRole() === "cli";
  return loadPlugins({
    env,
    records: skip ? [] : await readPluginRecords(env),
    binding,
  });
}

/**
 * Builds the application, dropping any plugin whose module it cannot build.
 *
 * A plugin whose providers do not resolve fails the whole container, and a
 * broken plugin must not be able to take the association's register offline
 * (ADR 0003). NestJS names the module in the error it throws, which is enough
 * to identify the plugin; when it is not, the most recently added plugin is
 * dropped instead. Either way the attempt is repeated until the application
 * builds, and a failure with no plugins left in the graph is the
 * application's own and is not caught.
 */
export async function createApplication(
  boot: PluginBoot,
): Promise<NestFastifyApplication> {
  const logger = new Logger("Bootstrap");
  setPluginBoot(boot);

  for (;;) {
    const modules = boot.plugins
      .map((plugin) => plugin.module)
      .filter((module) => module !== null);

    try {
      const app = await NestFactory.create<NestFastifyApplication>(
        AppModule.withPlugins(modules),
        new FastifyAdapter(),
        // Throw rather than exit the process, so a plugin that fails the
        // container can be dropped and the application built again.
        { abortOnError: false },
      );
      app.get(PluginHostBinder).bind();
      return app;
    } catch (cause) {
      const culprit = blame(boot, cause);
      if (culprit === null) {
        throw cause;
      }
      logger.error(
        `Plugin "${culprit.id}" could not be built into the application and ` +
          "was skipped.",
        cause,
      );
      culprit.context.serving = false;
      boot.plugins = boot.plugins.filter((plugin) => plugin !== culprit);
      boot.dormant.set(culprit.id, culprit.manifest);
      // The reason is logged above with the error itself and travels as a code
      // alone. NestJS composes that message from the plugin's own provider and
      // parameter names, which can hold anything the package chose to call
      // them, so it is an operator's to read and not a board's.
      boot.findings.push({
        id: culprit.id,
        directory: culprit.directory,
        reason: "module-failed",
        detail: {},
      });
    }
  }
}

/** Which plugin to drop, or null when the failure is not a plugin's. */
function blame(boot: PluginBoot, cause: unknown): BootPlugin | null {
  const candidates = boot.plugins.filter((plugin) => plugin.module !== null);
  if (candidates.length === 0) {
    return null;
  }

  // An anonymous module class has no name to look for, and matching on the
  // empty string would blame every plugin at once.
  const message = String(cause);
  const named = candidates.filter((plugin) => {
    const name = plugin.module?.module.name ?? "";
    return name !== "" && message.includes(name);
  });
  return named.length === 1 ? (named[0] ?? null) : (candidates.at(-1) ?? null);
}

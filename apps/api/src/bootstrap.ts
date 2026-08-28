import { sep } from "node:path";

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
import { failureFrames, failureName } from "./logging/failure";
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
 * (ADR 0003). NestJS names the module in the error it throws, and a failure
 * raised inside a bundle leaves that bundle in the stack, so the plugin at
 * fault is identified rather than guessed at; the attempt is then repeated
 * until the application builds. A failure that implicates no plugin is the
 * application's own and is not caught - `blame` says why nothing is dropped
 * on no evidence.
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
      // The class and the frames, never the message. NestJS composes that from
      // the plugin's own provider and parameter names, and a plugin's
      // constructor throws holding whatever it had just read.
      logger.error(
        `Plugin "${culprit.id}" could not be built into the application and ` +
          `was skipped: ${failureName(cause)}`,
        failureFrames(cause),
      );
      culprit.context.serving = false;
      boot.plugins = boot.plugins.filter((plugin) => plugin !== culprit);
      boot.dormant.set(culprit.id, culprit.manifest);
      // The reason travels as a code alone, for the same reason.
      boot.findings.push({
        id: culprit.id,
        directory: culprit.directory,
        reason: "module-failed",
        detail: {},
      });
    }
  }
}

/**
 * Which plugin to drop, or null when nothing implicates one.
 *
 * Two kinds of evidence, because the two kinds of failure leave different
 * traces, and they are not worth the same.
 *
 * The stack is asked first. A frame inside a package's directory is this
 * process's own record that the package's code ran and raised the failure. The
 * message is not: it is text, and the code that threw composed it. This branch
 * already treats what a plugin says as untrusted when deciding what may be
 * logged, and it is no more trustworthy as evidence - a constructor that throws
 * `new Error("OtherPluginModule")` would otherwise disable a working package
 * the board consented to, record it as broken, and leave the one that actually
 * threw running to fail the next attempt too. So text never overrules
 * structure; it only speaks where structure is silent.
 *
 * Structure is silent for the commonest failure of all: a dependency NestJS
 * cannot resolve is raised from inside its own injector, so no plugin frame
 * appears and the module named in the message is all there is. That is the
 * second check, and it is sound there precisely because nothing contradicts
 * it.
 *
 * Nothing is dropped without evidence. Dropping whichever plugin was added
 * last would disable a package that was working and record it for the board as
 * broken, which is a false statement about something the board consented to
 * and cannot tell apart from a true one. When the fault is the application's
 * own it is worse still: every installed plugin is made dormant one at a time
 * on the way to failing anyway. A failure this cannot place is the
 * application's to answer for, so it is rethrown.
 *
 * The error's text is read here and goes nowhere: it is matched against names
 * this application chose, never logged or served.
 *
 * Exported for its test: the alternative is driving a container into each
 * failure shape, which tests NestJS rather than the attribution.
 */
export function blame(boot: PluginBoot, cause: unknown): BootPlugin | null {
  const candidates = boot.plugins.filter((plugin) => plugin.module !== null);
  if (candidates.length === 0) {
    return null;
  }

  // Matched with the separator, so one package's directory is not read out of
  // another's: `openbrf-plugin-occupancy` is a prefix of
  // `openbrf-plugin-occupancy-pro`, and a bare substring would place a failure
  // in whichever of the two was installed first.
  const frames = failureFrames(cause) ?? "";
  const traced = candidates.filter((plugin) =>
    frames.includes(`${plugin.directory}${sep}`),
  );
  if (traced.length > 0) {
    // Several packages on one stack means each of them ran, and this cannot
    // say which is at fault. In practice there is only ever one: a plugin
    // cannot resolve another plugin's code, so there is no way for two bundles
    // to be on the same stack.
    return traced.length === 1 ? (traced[0] ?? null) : null;
  }

  const message = String(cause);
  const named = candidates.filter((plugin) => {
    // An anonymous module class has no name to look for, and matching on the
    // empty string would name every plugin at once.
    const name = plugin.module?.module.name ?? "";
    return name !== "" && mentions(message, name);
  });
  return named.length === 1 ? (named[0] ?? null) : null;
}

/**
 * Whether the message names the module, as a word rather than a substring.
 *
 * A bundler shortens a class name to a character or two, and `includes` on one
 * of those matches almost any sentence - which would read as a confident,
 * unique attribution to the wrong plugin. Scanned rather than matched with a
 * constructed pattern: the name comes from a package this process did not
 * write.
 */
function mentions(message: string, name: string): boolean {
  const isWordCharacter = (character: string | undefined): boolean =>
    character !== undefined && /[\w$]/.test(character);

  for (
    let at = message.indexOf(name);
    at !== -1;
    at = message.indexOf(name, at + 1)
  ) {
    if (
      !isWordCharacter(message[at - 1]) &&
      !isWordCharacter(message[at + name.length])
    ) {
      return true;
    }
  }
  return false;
}

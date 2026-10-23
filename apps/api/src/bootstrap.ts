import { sep } from "node:path";

import { type DynamicModule, Logger } from "@nestjs/common";
import { ModulesContainer, NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { PluginFindingDetail, PluginManifest } from "@openbrf/plugin-sdk";

import { AppModule } from "./app.module";
import { AuthorizationGuard } from "./authorization/authorization.guard";
import {
  resolveProtectedResource,
  setProtectedResource,
} from "./auth/protected-resource";
import { type Env, loadEnv } from "./config/env";
import { loadNearestEnvFile } from "./config/load-env-file";
import { processRole } from "./config/process-role";
import { ENV } from "./config/config.module";
import {
  registerDeviceRouteHeaders,
  registerRetiredDevicePathRefusal,
} from "./devices/device-route-headers";
import { resolveDeviceRoutes, setDeviceRoutes } from "./devices/device-routes";
import { registerSecurityHeaders } from "./http/security-headers";
import { failureFrames, failureName } from "./logging/failure";
import {
  type BootPlugin,
  loadPlugins,
  noPluginRecords,
  type PluginBoot,
  type PluginRecords,
  readPluginRecords,
  setPluginBoot,
} from "./plugins/plugin-boot";
import {
  type PluginHostBinding,
  pluginHostBinding,
} from "./plugins/plugin-host";
import { PluginHostBinder } from "./plugins/plugin-host.binder";
import { PluginLoaderService } from "./plugins/plugin-loader.service";
import {
  declaredModules,
  hostModules,
  rereadSealedModule,
  sealModuleInstances,
} from "./plugins/plugin-module-seal";

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
 * Starts listening, on the port the validated environment gives.
 *
 * The validated value and not `process.env.PORT`: an empty `PORT` reads as
 * unset there and is the default, where `Number("")` is 0 and a random port.
 * Here rather than in the entrypoint, which cannot be imported without
 * starting the application.
 */
export async function listen(
  app: Pick<NestFastifyApplication, "listen">,
  env: Pick<Env, "PORT">,
): Promise<void> {
  await app.listen(env.PORT, "0.0.0.0");
}

/**
 * Reads the data volume and returns what should be in the application's graph.
 *
 * The command-line process, which must never execute plugin code and serves
 * nothing, stops here without consulting the database. Plugins switched off
 * for the instance load nothing either, but their rows are still read: the
 * device routes they declare go on answering a device (below).
 */
export async function loadPluginsAtBoot(
  env: Env,
  binding: PluginHostBinding = pluginHostBinding,
): Promise<PluginBoot> {
  const read =
    processRole() === "cli" ? noPluginRecords() : await readPluginRecords(env);
  const boot = await loadPlugins({
    env,
    records: env.OPENBRF_PLUGINS_ENABLED ? read.records : [],
    binding,
  });

  /*
   * Which route connected apps sign in to is decided here, where the loaded
   * plugins and the environment are both in hand, and deliberately before
   * createApplication's drop loop: a plugin whose module fails to build once
   * must not move the audience, because every token already issued carries the
   * old one and would stop being accepted. A resource pointing at a route that
   * is temporarily not mounted answers 404 and recovers when the plugin does.
   */
  const resolved = resolveProtectedResource(boot.plugins, env);
  setProtectedResource(resolved.resource);
  boot.findings.push(...resolved.findings);

  /*
   * The device routes a device token opens, and every path a device may still
   * be asking: a device route that is not serving answers 404 with the headers
   * a device on another origin needs to read it (ADR 0031), and a 404 it
   * cannot read looks like a failure to connect, after which it goes on
   * showing what it had. The guard's device branch only ever runs for a plugin
   * that is serving, because the plugin serving guard answers the rest first.
   * A route nothing mounted reaches no guard at all, and a token presented on
   * a dropped route's path there is refused by the hook
   * `registerRetiredDevicePathRefusal`, while the plugin serves.
   */
  const declared = deviceRouteDeclarations(boot, read);
  setDeviceRoutes({
    current: resolveDeviceRoutes(declared.current),
    asked: resolveDeviceRoutes(declared.asked),
  });

  return boot;
}

type DeviceRouteDeclaration = Pick<PluginManifest, "id" | "deviceRoutes">;

/**
 * The device routes the plugins that loaded declare, and each plugin's paths a
 * device may still be asking.
 *
 * Current: what a plugin that loaded declares, and nothing else, because these
 * are the routes the seal held to the device route rules and a device token
 * opens.
 *
 * Asked: the current routes, and every path the board ever consented to as one
 * of a plugin's device routes. Those are the paths a device was given a token
 * for and goes on asking: a route a later consent dropped or moved, one the
 * version serving now dropped, and those of a plugin that is switched off,
 * refused, removed or installed again. Its token was revoked or is paused, and
 * the device can read the answer that tells it so. Not what the volume holds
 * for a plugin with a row, which for a plugin that is not running may be the
 * very version refused for moving a route the board has not seen. Last, for a
 * plugin with no row, what its package on the volume declares.
 */
function deviceRouteDeclarations(
  boot: PluginBoot,
  read: PluginRecords,
): { current: DeviceRouteDeclaration[]; asked: DeviceRouteDeclaration[] } {
  const current = boot.plugins.map((plugin) => ({
    id: plugin.id,
    deviceRoutes: [...plugin.manifest.deviceRoutes],
  }));
  const kept: DeviceRouteDeclaration[] = [...read.deviceRoutePaths].map(
    ([id, deviceRoutes]) => ({ id, deviceRoutes: [...deviceRoutes] }),
  );
  const rows = new Set(read.records.map((record) => record.id));
  for (const [id, manifest] of boot.dormant) {
    if (!rows.has(id)) {
      kept.push({ id, deviceRoutes: [...manifest.deviceRoutes] });
    }
  }
  // A current route first, so that a path both name is read as current.
  return { current, asked: [...current, ...kept] };
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
 *
 * A plugin whose module the seal refuses when it reads it again, before the
 * build or once it is built, or when NestJS built something from it the seal
 * did not read, is dropped the same way, as `module-refused`.
 */
export async function createApplication(
  boot: PluginBoot,
): Promise<NestFastifyApplication> {
  const logger = new Logger("Bootstrap");
  setPluginBoot(boot);
  // The application's own modules, which a plugin's module may import.
  const declared = declaredModules(AppModule);

  for (;;) {
    /*
     * The plugin's code has run since it was sealed - anything its factory
     * scheduled, while the other plugins loaded - so what the seal read is
     * read again before NestJS reads it.
     */
    const changed = refusedPlugin(boot, rereadSealedModule);
    if (changed !== null) {
      logger.warn(`Plugin "${changed.plugin.id}" not loaded: ${changed.log}`);
      drop(boot, changed.plugin, "module-refused");
      continue;
    }

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
      /*
       * Before anything else reads the container. The application is left
       * unclosed, as a build that failed part way is: it was never
       * initialised, and closing it would run the refused plugin's hooks.
       */
      const container = app.get(ModulesContainer);
      const host = await hostModules(declared, app);
      const refused = refusedPlugin(boot, (module) =>
        sealModuleInstances(module, container.values(), host),
      );
      if (refused !== null) {
        logger.warn(`Plugin "${refused.plugin.id}" not loaded: ${refused.log}`);
        drop(boot, refused.plugin, "module-refused");
        continue;
      }
      app.get(PluginHostBinder).bind();
      // Here rather than in main.ts, so the integration suites that build the
      // application through this function answer with the same headers a
      // running instance does.
      registerSecurityHeaders(
        app.getHttpAdapter().getInstance(),
        app.get<Env>(ENV),
      );
      registerDeviceRouteHeaders(app.getHttpAdapter().getInstance());
      const loader = app.get(PluginLoaderService);
      const guard = app.get(AuthorizationGuard);
      registerRetiredDevicePathRefusal(app.getHttpAdapter().getInstance(), {
        serving: (pluginId) => loader.get(pluginId) !== null,
        refusal: (request) => guard.retiredPathRefusal(request),
      });
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
      // The reason travels as a code alone, for the same reason.
      drop(boot, culprit, "module-failed");
    }
  }
}

/**
 * Takes a plugin out of the next build and reports it.
 *
 * And every addon that extends it (ADR 0030), as `PluginLoaderService.unload`
 * does once the application is running: an addon exists for its host plugin,
 * so it is not built and does not serve while the host plugin is not here. It
 * stays installed and consented to, and the finding says why it stopped. An
 * addon cannot be extended in turn, so one level settles it.
 */
function drop(
  boot: PluginBoot,
  plugin: BootPlugin,
  reason: "module-failed" | "module-refused",
): void {
  stop(boot, plugin, reason, {});
  for (const addon of boot.plugins.filter((each) =>
    each.manifest.extends.some((extension) => extension.plugin === plugin.id),
  )) {
    stop(boot, addon, "extension-host-missing", { plugin: plugin.id });
  }
}

function stop(
  boot: PluginBoot,
  plugin: BootPlugin,
  reason: "module-failed" | "module-refused" | "extension-host-missing",
  detail: PluginFindingDetail,
): void {
  plugin.context.serving = false;
  boot.plugins = boot.plugins.filter((each) => each !== plugin);
  boot.dormant.set(plugin.id, plugin.manifest);
  boot.findings.push({
    id: plugin.id,
    directory: plugin.directory,
    reason,
    detail,
  });
}

/**
 * The first plugin whose sealed module a read refuses, with why.
 *
 * Read before the application is built (`rereadSealedModule`) and once it is
 * built: NestJS asks a module's instance rather than its class
 * (`sealModuleInstances`), so that is the seal's last read and the one that
 * has to wait for the container.
 */
function refusedPlugin(
  boot: PluginBoot,
  read: (module: DynamicModule) => string | null,
): { plugin: BootPlugin; log: string } | null {
  for (const plugin of boot.plugins) {
    if (plugin.module === null) {
      continue;
    }
    const log = read(plugin.module);
    if (log !== null) {
      return { plugin, log };
    }
  }
  return null;
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

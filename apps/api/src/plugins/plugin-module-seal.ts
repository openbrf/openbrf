import type { DynamicModule } from "@nestjs/common";
import {
  CONTROLLER_WATERMARK,
  GLOBAL_MODULE_METADATA,
  HOST_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";

import type { Capability } from "../authorization/capabilities";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";

/**
 * Making a plugin's NestJS module safe to register in the application.
 *
 * A plugin contributes a real module, so its controllers, providers, guards
 * and lifecycle hooks are the framework's own. That is the point of the
 * contract; it is also the whole of its risk, because a module can declare
 * things whose effect is application-wide. Everything here is the difference
 * between "a plugin writes ordinary NestJS code" and "a plugin can reach
 * anything NestJS can reach".
 *
 * Two kinds of work, done before the module is handed to NestFactory:
 *
 *   What is rewritten. Every controller is moved under the plugin's own path
 *   prefix and given the capability floor its plugin's permissions imply, and
 *   any attempt to mark a route public is removed. A plugin cannot decline
 *   these; they are applied to the classes themselves, and the application's
 *   own global guard is what enforces the result.
 *
 *   What is refused. A module that registers application-wide behaviour - a
 *   global guard, interceptor, filter or pipe, middleware, or a `@Global()`
 *   module - would act on the core's routes and not only on its own. There is
 *   no legitimate plugin reason to do it and no way to scope it after the
 *   fact, so the plugin is skipped and reported instead, exactly as a
 *   malformed manifest is.
 */

/** Marks a controller as belonging to a plugin, for the guard and the filter. */
export const PLUGIN_ID_METADATA = "openbrf:plugin-id";

/**
 * Tokens that make a provider apply to the whole application.
 *
 * Registering one from a plugin would put the plugin's code in front of every
 * core route: an interceptor could rewrite the register's responses, a filter
 * could swallow the core's errors, and a guard could refuse every request on
 * the instance.
 */
const APPLICATION_WIDE_TOKENS: ReadonlyMap<unknown, string> = new Map([
  [APP_GUARD, "APP_GUARD"],
  [APP_INTERCEPTOR, "APP_INTERCEPTOR"],
  [APP_FILTER, "APP_FILTER"],
  [APP_PIPE, "APP_PIPE"],
]);

/** How deep a plugin's own module graph may go before it is refused. */
const MAX_MODULE_DEPTH = 16;

export interface SealOptions {
  pluginId: string;
  /** The capability floor the plugin's permissions imply. */
  floor: Capability;
}

export type SealResult =
  | { ok: true; module: DynamicModule; controllers: string[] }
  | {
      ok: false;
      reason: "module-invalid" | "module-refused";
      /**
       * The operator's line, in English.
       *
       * Named for the log rather than for the screen, because it names a
       * framework construct the plugin's author misused. The board reads the
       * sentence the reason code is translated into and reinstalls or asks the
       * author either way; which decorator was at fault is what the person
       * reading the container's output needs.
       */
      log: string;
    };

/**
 * Where a plugin's routes are mounted.
 *
 * Singular, so it cannot collide with the `/api/plugins` administration
 * routes, which are the host's own and are not a plugin's to serve.
 */
function pluginRoutePrefix(pluginId: string): string {
  return `api/plugin/${pluginId}`;
}

/**
 * Checks and rewrites a plugin's module, or explains why it was refused.
 *
 * Never throws for a plugin's own defect: the caller turns the refusal into a
 * finding on the admin screen, and a broken plugin must not be able to take
 * the association's register offline.
 */
export function sealPluginModule(
  candidate: unknown,
  options: SealOptions,
): SealResult {
  if (!isDynamicModule(candidate)) {
    return {
      ok: false,
      reason: "module-invalid",
      log:
        "The server bundle's createPlugin did not return a NestJS dynamic " +
        "module: an object with a `module` class, and optionally controllers, " +
        "providers and imports.",
    };
  }

  const controllers: unknown[] = [];
  const refusal = walk(candidate, {
    controllers,
    seen: new Set<unknown>(),
    depth: 0,
  });
  if (refusal !== null) {
    return { ok: false, reason: "module-refused", log: refusal };
  }

  const prefix = pluginRoutePrefix(options.pluginId);
  const names: string[] = [];

  for (const controller of controllers) {
    const sealed = sealController(controller, prefix, options);
    if (!sealed.ok) {
      return { ok: false, reason: "module-refused", log: sealed.log };
    }
    names.push(sealed.path);
  }

  return { ok: true, module: candidate, controllers: names };
}

interface WalkState {
  controllers: unknown[];
  seen: Set<unknown>;
  depth: number;
}

/** Collects the module graph's controllers, or returns why it is refused. */
function walk(entry: unknown, state: WalkState): string | null {
  if (entry === null || entry === undefined) {
    return null;
  }
  if (state.depth > MAX_MODULE_DEPTH) {
    return `The module graph nests deeper than ${String(MAX_MODULE_DEPTH)} levels.`;
  }

  const reference = resolveForwardReference(entry);
  if ("refusal" in reference) {
    return reference.refusal;
  }
  const resolved = reference.entry;
  if (resolved === null || resolved === undefined || state.seen.has(resolved)) {
    return null;
  }
  state.seen.add(resolved);

  const dynamic = isDynamicModule(resolved) ? resolved : null;
  const moduleClass = dynamic === null ? resolved : dynamic.module;

  if (typeof moduleClass !== "function") {
    return "A module in the graph is neither a class nor a dynamic module.";
  }

  // Read from both the class's decorator and the dynamic object, because
  // NestJS merges the two and a check that read only one would be told half
  // the truth.
  if (
    reflect(moduleClass, GLOBAL_MODULE_METADATA) === true ||
    dynamic?.global === true
  ) {
    return (
      `The module "${moduleClass.name}" is declared global, which would ` +
      "export its providers into every module in the application."
    );
  }

  const modulePrototype = moduleClass.prototype as
    { configure?: unknown } | undefined;
  if (typeof modulePrototype?.configure === "function") {
    return (
      `The module "${moduleClass.name}" registers middleware, which would ` +
      "run on the application's own routes as well as the plugin's."
    );
  }

  const providers = [
    ...asArray(reflect(moduleClass, MODULE_METADATA.PROVIDERS)),
    ...asArray(dynamic?.providers),
  ];
  for (const provider of providers) {
    const name = APPLICATION_WIDE_TOKENS.get(providerToken(provider));
    if (name !== undefined) {
      return (
        `The module "${moduleClass.name}" registers an application-wide ` +
        `${name}, which would act on the application's own routes.`
      );
    }
  }

  for (const controller of [
    ...asArray(reflect(moduleClass, MODULE_METADATA.CONTROLLERS)),
    ...asArray(dynamic?.controllers),
  ]) {
    if (!state.controllers.includes(controller)) {
      state.controllers.push(controller);
    }
  }

  for (const imported of [
    ...asArray(reflect(moduleClass, MODULE_METADATA.IMPORTS)),
    ...asArray(dynamic?.imports),
  ]) {
    const nested = walk(imported, { ...state, depth: state.depth + 1 });
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

/**
 * Rewrites one controller, or returns why the plugin is refused.
 *
 * Returns the controller's sealed path on success, which is what the boot log
 * reports: an operator reading it can see where a plugin's routes actually
 * ended up, which is not something the plugin's own source shows.
 */
function sealController(
  controller: unknown,
  prefix: string,
  options: SealOptions,
): { ok: true; path: string } | { ok: false; log: string } {
  if (typeof controller !== "function") {
    return {
      ok: false,
      log: "A controller in the module graph is not a class.",
    };
  }
  if (reflect(controller, CONTROLLER_WATERMARK) !== true) {
    return {
      ok: false,
      log: `"${controller.name}" is listed as a controller but is not decorated with @Controller.`,
    };
  }
  if (ownMetadata(controller, PLUGIN_ID_METADATA) !== undefined) {
    return {
      ok: false,
      log: `The controller "${controller.name}" appears in more than one plugin module.`,
    };
  }

  const declared = reflect(controller, PATH_METADATA);
  const paths = Array.isArray(declared) ? declared : [declared];
  const rewritten: string[] = [];

  for (const path of paths) {
    const own = normalizeSegment(path);
    if (own === null) {
      return {
        ok: false,
        log:
          `The controller "${controller.name}" declares the path ` +
          `${JSON.stringify(path)}, which steps outside the plugin's own prefix.`,
      };
    }
    rewritten.push(own === "" ? prefix : `${prefix}/${own}`);
  }

  // Handler paths stay relative to the controller, so only their shape is
  // checked. Stripping @Public() has to happen here as well as on the class:
  // the guard reads the handler first and a method-level opt-out would win.
  const prototype: unknown = controller.prototype;
  if (typeof prototype === "object" && prototype !== null) {
    for (const name of handlerNames(prototype)) {
      const handler: unknown = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== "function") {
        continue;
      }
      if (reflect(handler, METHOD_METADATA) === undefined) {
        continue;
      }
      const methodPath = reflect(handler, PATH_METADATA);
      for (const path of Array.isArray(methodPath)
        ? methodPath
        : [methodPath]) {
        if (path !== undefined && normalizeSegment(path) === null) {
          return {
            ok: false,
            log:
              `The route ${controller.name}.${name} declares the path ` +
              `${JSON.stringify(path)}, which steps outside the plugin's own prefix.`,
          };
        }
      }
      // Defined false rather than deleted: deleting removes only the class's
      // own metadata, and a plugin controller extending a base that declared
      // itself public would keep the inherited opt-out.
      Reflect.defineMetadata(IS_PUBLIC_ROUTE, false, handler);
    }
  }

  Reflect.defineMetadata(
    PATH_METADATA,
    Array.isArray(declared) ? rewritten : rewritten[0],
    controller,
  );
  // A plugin route answers on the instance's own host, whatever the controller
  // asked for.
  Reflect.defineMetadata(HOST_METADATA, undefined, controller);
  Reflect.defineMetadata(IS_PUBLIC_ROUTE, false, controller);

  // Merged, not replaced: the guard reads the class's list and the handler's
  // together, so a route asking for more than the floor keeps what it asked
  // for and no route can ask for less.
  const existing = asArray<Capability>(
    reflect(controller, REQUIRED_CAPABILITIES),
  );
  Reflect.defineMetadata(
    REQUIRED_CAPABILITIES,
    existing.includes(options.floor) ? existing : [...existing, options.floor],
    controller,
  );
  Reflect.defineMetadata(PLUGIN_ID_METADATA, options.pluginId, controller);

  return { ok: true, path: rewritten.join(", ") };
}

/**
 * Every method name a controller answers on, inherited ones included.
 *
 * NestJS discovers route handlers across the whole prototype chain, so a
 * controller that inherits a decorated method from a base class serves that
 * route without declaring anything itself. A scan of own properties alone
 * would leave such a handler unsealed: its path would go unchecked and, worse,
 * an inherited `@Public()` would survive - and the authorization guard reads
 * the handler's metadata before the class's, so the opt-out on the handler
 * would win over the seal applied to the controller.
 *
 * Walked in the same order NestJS walks it, stopping short of Object.prototype
 * and keeping the first name seen, so a subclass override is the function that
 * gets sealed rather than the base's.
 */
function handlerNames(prototype: object): string[] {
  const names: string[] = [];
  const seen = new Set<string>(["constructor"]);

  for (
    let current: object | null = prototype;
    current !== null && current !== Object.prototype;
    current = Reflect.getPrototypeOf(current)
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

/**
 * One spelling for a path fragment, or null when it steps outside its prefix.
 *
 * A `..` segment cannot escape a prefix in the router - paths are matched
 * segment by segment, not resolved - but a route registered with one is a
 * route nothing can reach, and a plugin that wrote it meant something else.
 */
function normalizeSegment(path: unknown): string | null {
  if (path === undefined || path === null) {
    return "";
  }
  if (typeof path !== "string") {
    return null;
  }
  const trimmed = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.split("/").includes("..")) {
    return null;
  }
  return trimmed;
}

/** Unwraps a forwardRef, or explains why the entry cannot be checked. */
function resolveForwardReference(
  entry: unknown,
): { entry: unknown } | { refusal: string } {
  if (typeof entry !== "object" || entry === null) {
    return { entry };
  }
  if ("then" in entry) {
    return {
      refusal:
        "A module in the graph is imported as a promise, which cannot be " +
        "checked before the application is built.",
    };
  }
  const forwardRef = (entry as { forwardRef?: unknown }).forwardRef;
  if (typeof forwardRef !== "function") {
    return { entry };
  }
  try {
    return { entry: (forwardRef as () => unknown)() };
  } catch (cause) {
    return {
      refusal: `A forward reference in the module graph could not be resolved: ${String(cause)}`,
    };
  }
}

function isDynamicModule(value: unknown): value is DynamicModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "module" in value &&
    typeof (value as { module: unknown }).module === "function"
  );
}

function providerToken(provider: unknown): unknown {
  if (typeof provider === "function") {
    return provider;
  }
  if (
    typeof provider === "object" &&
    provider !== null &&
    "provide" in provider
  ) {
    return (provider as { provide: unknown }).provide;
  }
  return null;
}

function reflect(target: object, key: string): unknown {
  return Reflect.getMetadata(key, target) as unknown;
}

function ownMetadata(target: object, key: string): unknown {
  return Reflect.getOwnMetadata(key, target) as unknown;
}

function asArray<Value>(value: unknown): Value[] {
  return Array.isArray(value) ? (value as Value[]) : [];
}

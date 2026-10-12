import { types } from "node:util";

import type { DynamicModule, Type } from "@nestjs/common";
import type { ModulesContainer } from "@nestjs/core";

/**
 * The check on what a plugin's module was built into, after NestJS built it.
 *
 * The module seal reads classes: a module's prototype, a controller's
 * prototype and the metadata on its methods. NestJS reads some of the same
 * things from the objects it constructed instead. It asks a module's instance
 * whether it registers middleware, it serves a controller's routes from the
 * instance's own methods, and it tells guards which class a request reached
 * from the instance's `constructor`. A constructor or a class field decides
 * what those objects hold, and neither runs until the container is built, so
 * no check on the class can see what they did.
 *
 * So the host looks again once `NestFactory.create` has returned and before
 * the application is initialised: middleware is registered and routes are
 * explored during initialisation, so this is the last moment at which what the
 * instances hold can still keep a plugin out. Each module a plugin brought,
 * and each of its controllers, has to be what the class the seal approved
 * would build:
 *
 *   - a module instance has no `configure` anywhere on its prototype chain,
 *     the same rule the seal applies to the class;
 *   - a controller is a singleton, because a controller built per request is
 *     built after this check has run;
 *   - a controller instance has its class's prototype, that prototype names
 *     the class as its constructor, and the instance has no property of its
 *     own that a name on the prototype chain would otherwise answer.
 *
 * Every read here is of own properties and prototypes, and a proxy anywhere
 * along the way is refused rather than asked, so no plugin code runs while the
 * check is made.
 *
 * What a plugin schedules to run later - a timer, a promise its constructor
 * leaves pending - can still change an instance after this. That is the same
 * runtime residual ADR 0008 records for the seal.
 */

/** Which rule an instance broke. The log says which; the admin screen does not. */
export type InstanceFault = "middleware" | "scope" | "class" | "method";

/** What the server log says about each fault. Never the plugin's own text. */
export const INSTANCE_FAULTS: Readonly<Record<InstanceFault, string>> = {
  middleware:
    "a module it brought registers middleware, which would run on the " +
    "application's own routes as well as the plugin's",
  scope:
    "a controller it brought is not a singleton, so its instances are built " +
    "after the host has checked them",
  class:
    "a controller it brought was built as something other than an instance " +
    "of the class that was sealed",
  method:
    "a controller instance it brought holds its own value under a name its " +
    "class declares, which NestJS would use in place of the sealed method",
};

/**
 * How far a prototype chain is followed before it is refused as unreadable.
 *
 * The same bound the seal uses: a class hierarchy is a handful of links deep,
 * and a chain built to be endless must not stall the boot.
 */
const CHAIN_LIMIT = 64;

/** One module in the container NestJS built. */
type BuiltModule = ModulesContainer extends Map<string, infer M> ? M : never;
/** How NestJS holds one controller of a built module. */
type BuiltController =
  BuiltModule["controllers"] extends Map<unknown, infer W> ? W : never;

/**
 * The first plugin whose built module breaks one of the rules above, and the
 * rule it broke, or null when every plugin's instances are what was sealed.
 *
 * `root` is the application's own module. What it reaches without passing
 * through a plugin's module is the application's, and is not held to these
 * rules: a plugin's module reaches every global module the application has,
 * and those are not the plugin's to answer for.
 */
export function refusedInstance<P extends { module: DynamicModule | null }>(
  modules: ModulesContainer,
  root: Type,
  plugins: readonly P[],
): { plugin: P; fault: InstanceFault } | null {
  const pluginRoots = new Set<unknown>(
    plugins.map((plugin) => plugin.module?.module),
  );
  const built = [...modules.values()];
  const core = reachable(
    built.filter((moduleRef) => moduleRef.metatype === root),
    (moduleRef) => !pluginRoots.has(moduleRef.metatype),
  );

  for (const plugin of plugins) {
    if (plugin.module === null) {
      continue;
    }
    const pluginModule = plugin.module.module;
    const own = reachable(
      built.filter((moduleRef) => moduleRef.metatype === pluginModule),
      (moduleRef) => !core.has(moduleRef),
    );
    for (const moduleRef of own) {
      const fault = moduleFault(moduleRef);
      if (fault !== null) {
        return { plugin, fault };
      }
    }
  }
  return null;
}

/** Every module reached from `from` through its imports, as far as `enter` allows. */
function reachable(
  from: readonly BuiltModule[],
  enter: (moduleRef: BuiltModule) => boolean,
): Set<BuiltModule> {
  const seen = new Set<BuiltModule>();
  const pending = from.filter(enter);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    for (const imported of next.imports) {
      if (!seen.has(imported) && enter(imported)) {
        pending.push(imported);
      }
    }
  }
  return seen;
}

function moduleFault(moduleRef: BuiltModule): InstanceFault | null {
  // What NestJS's MiddlewareModule asks: `instance.configure`, on the
  // instance, through its whole prototype chain.
  const instance: unknown = moduleRef.instance;
  if (isObject(instance) && chainHolds(instance, "configure")) {
    return "middleware";
  }
  for (const wrapper of moduleRef.controllers.values()) {
    const fault = controllerFault(wrapper);
    if (fault !== null) {
      return fault;
    }
  }
  return null;
}

function controllerFault(wrapper: BuiltController): InstanceFault | null {
  // A controller that depends on anything request-scoped is request-scoped
  // itself, and NestJS then constructs it for each request and serves the
  // methods of that object - one this check never sees.
  if (wrapper.isTransient || !wrapper.isDependencyTreeStatic()) {
    return "scope";
  }

  const { metatype } = wrapper;
  const instance: unknown = wrapper.instance;
  if (
    typeof metatype !== "function" ||
    types.isProxy(metatype) ||
    !isObject(instance) ||
    types.isProxy(instance)
  ) {
    return "class";
  }

  // `prototype` on a function that is not a proxy is a data property that
  // cannot be redefined as an accessor, so reading it runs nothing.
  const prototype: unknown = metatype.prototype;
  if (
    !isObject(prototype) ||
    types.isProxy(prototype) ||
    Object.getPrototypeOf(instance) !== prototype
  ) {
    return "class";
  }

  // NestJS reads a class's guards and interceptors from
  // `Object.getPrototypeOf(instance).constructor`, and gives guards
  // `instance.constructor` as the class a request reached - which is where
  // the plugin's id and its capability floor are read from.
  const declared = Object.getOwnPropertyDescriptor(prototype, "constructor");
  if (declared === undefined || declared.value !== metatype) {
    return "class";
  }

  const names = chainNames(prototype);
  if (names === null) {
    return "class";
  }
  // NestJS reads a route's metadata from the prototype and calls the
  // instance's method of the same name, and an own property is found first.
  // `constructor` is on the list too, for the reason given above.
  for (const name of Object.getOwnPropertyNames(instance)) {
    if (names.has(name)) {
      return "method";
    }
  }
  return null;
}

/**
 * Whether `key` is on the value or anywhere on its prototype chain.
 *
 * A chain that cannot be read without running plugin code - a proxy, or one
 * longer than any class needs - answers yes, so it is refused.
 */
function chainHolds(value: object, key: string): boolean {
  let link: object | null = value;
  for (let depth = 0; link !== null; depth += 1) {
    if (depth >= CHAIN_LIMIT || types.isProxy(link)) {
      return true;
    }
    if (Object.hasOwn(link, key)) {
      return true;
    }
    link = Object.getPrototypeOf(link) as object | null;
  }
  return false;
}

/**
 * Every own name on a prototype chain, stopping where NestJS's own scan of a
 * controller stops: at `Object.prototype`. Null when the chain cannot be read
 * without running plugin code.
 */
function chainNames(prototype: object): Set<string> | null {
  const names = new Set<string>();
  let link: object | null = prototype;
  for (let depth = 0; link !== null && link !== Object.prototype; depth += 1) {
    if (depth >= CHAIN_LIMIT || types.isProxy(link)) {
      return null;
    }
    for (const name of Object.getOwnPropertyNames(link)) {
      names.add(name);
    }
    link = Object.getPrototypeOf(link) as object | null;
  }
  return names;
}

function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

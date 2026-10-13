import { types } from "node:util";

import { MODULE_METADATA } from "@nestjs/common/constants";
import type { Type } from "@nestjs/common";
import type { ModulesContainer } from "@nestjs/core";

import type { SealedModule } from "./plugin-module-seal";

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
 *     own that a name on the prototype chain would otherwise answer;
 *   - the methods on that prototype chain are the functions the seal read
 *     there, so a constructor cannot swap a sealed route for one of its own.
 *
 * Which built modules are a plugin's is decided from what the seal kept
 * (`SealedModule`), never from the plugin's own module object, which its
 * constructors could repoint by now. And a module that cannot be placed is not
 * waved through as the application's own: every module a plugin's root
 * reaches has to be one the seal read, and every module the application's
 * root imports has to be one it declares, a global one, or a sealed plugin's.
 *
 * Every read here is of own properties and prototypes, and a proxy anywhere
 * along the way is refused rather than asked, so no plugin code runs while the
 * check is made.
 *
 * What runs after this can still change an instance: a plugin's lifecycle
 * hooks, its request handlers, and whatever its constructors scheduled - a
 * timer, a pending promise. That is the same runtime residual ADR 0008
 * records for the seal.
 */

/** Which rule an instance broke. The log says which; the admin screen does not. */
export type InstanceFault =
  | "middleware"
  | "scope"
  | "class"
  | "method"
  | "prototype"
  | "module"
  | "unattributed";

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
  prototype:
    "a controller it brought has a method on its class that the seal did " +
    "not read there, which NestJS would route unchecked",
  module:
    "it was built into the application with a module other than the ones " +
    "that were sealed",
  unattributed:
    "the application was built with a module that is neither its own nor " +
    "one a plugin was sealed with, so no plugin can be cleared of bringing it",
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
 * The plugins refused for what was built, and the rule they broke, or null
 * when every plugin's instances are what was sealed.
 *
 * Usually the first plugin that broke a rule, alone. When the application's
 * root imports a module that nothing accounts for, every plugin with a module
 * is returned: one of them brought it, and nothing here can say which.
 *
 * `root` is the application's own module. What it reaches without passing
 * through a plugin's module is the application's, and is not held to these
 * rules: a plugin's module reaches every global module the application has,
 * and those are not the plugin's to answer for.
 */
export function refusedInstance<P extends { sealed: SealedModule | null }>(
  modules: ModulesContainer,
  root: Type,
  plugins: readonly P[],
): { plugins: P[]; fault: InstanceFault } | null {
  const contributing = plugins.filter((plugin) => plugin.sealed !== null);
  if (contributing.length === 0) {
    return null;
  }
  const pluginRoots = new Set<unknown>(
    contributing.map((plugin) => plugin.sealed?.root),
  );
  const built = [...modules.values()];
  const roots = built.filter((moduleRef) => moduleRef.metatype === root);

  // The root's imports are what it declares, the global modules NestJS links
  // into every module, and the plugins' modules. Anything else came from a
  // plugin's module object naming one class to the seal and another to
  // NestJS, and counting it as the application's would leave it unchecked.
  const declared = declaredImports(root);
  for (const moduleRef of roots) {
    for (const imported of moduleRef.imports) {
      if (
        !imported.isGlobal &&
        !declared.has(imported.metatype) &&
        !pluginRoots.has(imported.metatype)
      ) {
        return { plugins: contributing, fault: "unattributed" };
      }
    }
  }

  const core = reachable(
    roots,
    (moduleRef) => !pluginRoots.has(moduleRef.metatype),
  );

  for (const plugin of contributing) {
    const sealed = plugin.sealed;
    if (sealed === null) {
      continue;
    }
    const top = built.filter((moduleRef) => moduleRef.metatype === sealed.root);
    if (top.length === 0) {
      return { plugins: [plugin], fault: "module" };
    }
    for (const moduleRef of reachable(top, (entry) => !core.has(entry))) {
      const fault = sealed.modules.has(moduleRef.metatype)
        ? moduleFault(moduleRef, sealed)
        : "module";
      if (fault !== null) {
        return { plugins: [plugin], fault };
      }
    }
  }
  return null;
}

/**
 * The module classes a module's own decorator imports.
 *
 * The application's classes, read from metadata: no plugin object is asked.
 */
function declaredImports(moduleClass: Type): Set<unknown> {
  const entries: unknown = Reflect.getMetadata(
    MODULE_METADATA.IMPORTS,
    moduleClass,
  );
  return new Set(
    (Array.isArray(entries) ? entries : []).map((entry: unknown) =>
      typeof entry === "object" && entry !== null && "module" in entry
        ? entry.module
        : entry,
    ),
  );
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

function moduleFault(
  moduleRef: BuiltModule,
  sealed: SealedModule,
): InstanceFault | null {
  // What NestJS's MiddlewareModule asks: `instance.configure`, on the
  // instance, through its whole prototype chain.
  const instance: unknown = moduleRef.instance;
  if (isObject(instance) && chainHolds(instance, "configure")) {
    return "middleware";
  }
  for (const wrapper of moduleRef.controllers.values()) {
    const fault = controllerFault(wrapper, sealed);
    if (fault !== null) {
      return fault;
    }
  }
  return null;
}

function controllerFault(
  wrapper: BuiltController,
  sealed: SealedModule,
): InstanceFault | null {
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
  // A controller the seal never approved: its paths and its routes' marks
  // are as the plugin wrote them.
  const methods = sealed.controllers.get(metatype);
  if (methods === undefined) {
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

  const chain = readChain(prototype);
  if (chain === null) {
    return "class";
  }
  // NestJS reads a route's metadata from the prototype and calls the
  // instance's method of the same name, and an own property is found first.
  // `constructor` is on the list too, for the reason given above.
  for (const name of Object.getOwnPropertyNames(instance)) {
    if (chain.names.has(name)) {
      return "method";
    }
  }
  // NestJS routes whatever function the prototype holds by then. One the seal
  // did not read there carries metadata it never checked - a path, or the
  // public mark it clears on each route.
  for (const [name, method] of chain.methods) {
    if (methods.get(name) !== method) {
      return "prototype";
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
 * What a prototype chain holds, read the way NestJS's own scan of a controller
 * reads it and stopping where that stops, at `Object.prototype`: every own
 * name, and under each name the first data property that holds a function,
 * which is what NestJS would route. Accessors are skipped, as NestJS skips
 * them. Null when the chain cannot be read without running plugin code.
 */
function readChain(
  prototype: object,
): { names: Set<string>; methods: Map<string, unknown> } | null {
  const names = new Set<string>();
  const methods = new Map<string, unknown>();
  let link: object | null = prototype;
  for (let depth = 0; link !== null && link !== Object.prototype; depth += 1) {
    if (depth >= CHAIN_LIMIT || types.isProxy(link)) {
      return null;
    }
    for (const name of Object.getOwnPropertyNames(link)) {
      if (names.has(name)) {
        continue;
      }
      names.add(name);
      const value: unknown = Object.getOwnPropertyDescriptor(link, name)?.value;
      if (name !== "constructor" && typeof value === "function") {
        methods.set(name, value);
      }
    }
    link = Object.getPrototypeOf(link) as object | null;
  }
  return { names, methods };
}

function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

import { types } from "node:util";

import type { DynamicModule } from "@nestjs/common";
import {
  CONTROLLER_WATERMARK,
  EXCEPTION_FILTERS_METADATA,
  GLOBAL_MODULE_METADATA,
  GUARDS_METADATA,
  HOST_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  PIPES_METADATA,
  PROPERTY_DEPS_METADATA,
  ROUTE_ARGS_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from "@nestjs/common/constants";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";

import type { Capability } from "../authorization/capabilities";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { failureName } from "../logging/failure";

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

/** One provider a plugin's own module may not be constructed with. */
export interface DeniedInjection {
  /**
   * The identifier the exporting module lists in its `exports:`, where a core
   * module exports it.
   *
   * What `scripts/check-plugin-injections.mjs` matches against, so that a
   * thirteenth `@Global()` module cannot widen the surface without somebody
   * classifying what it exports. Empty for a token the framework provides
   * rather than a module of ours.
   */
  readonly exported: string;
  /**
   * The token as the container finally sees it: a class's name, a symbol's
   * description, or the string itself.
   *
   * The two differ for the tokens that are not classes. `ENV` is
   * `Symbol("OPENBRF_ENV")` and `PROTECTED_RESOURCE` is the string
   * `"PROTECTED_RESOURCE"`, so a set of class names could never have refused
   * either however it was spelled.
   */
  readonly token: string;
  /** Why a plugin holding it would be holding more than the board consented to. */
  readonly why: string;
}

/**
 * Every provider a plugin's module can resolve from the root injector, denied.
 *
 * Twelve of the platform's modules are `@Global()`, which puts everything they
 * export into the root injector where any loaded plugin's constructor can ask
 * for it. A plugin's sealed module is part of that same graph -
 * `AppModule.withPlugins` spreads plugin modules into one `NestFactory.create`,
 * with no child application and no `app.select()` - so every one of those
 * exports is reachable. Neither the global refusal above nor the
 * application-wide token check prevents that: those stop a plugin EXPORTING
 * something everywhere, and this stops it IMPORTING something it was never
 * given.
 *
 * A denylist over a classification rather than a short list of the obvious
 * ones, because the defect this replaces was not a wrong entry but a missing
 * one: the list named six of the thirteen, and three of the seven it missed are
 * services the host deliberately wraps before it hands them over. The guard
 * script reads every `@Global()` module's `exports:` and fails on a name that
 * appears nowhere here, so the next global module has to be classified rather
 * than merely added.
 *
 * Matched by name rather than by identity, because the seal runs over a module
 * the plugin's own bundle produced and comparing constructors across a realm
 * boundary is exactly what the module-identity check exists to catch
 * separately. A plugin reaching for one of these gets `forbidden-injection`.
 *
 * This covers what a module class, a provider, a controller or a guard,
 * interceptor, pipe or filter one of them names DECLARES, by constructor or by
 * field. Resolving the same class through `ModuleRef` at runtime is a second
 * half that a declaration check cannot see; the injector handles below are what
 * make a plugin declaring one of those a boot finding rather than a silent
 * reach.
 */
export const DENIED_INJECTIONS: readonly DeniedInjection[] = [
  {
    exported: "AuditLogService",
    token: "AuditLogService",
    why: "it writes the append-only log, so a plugin holding it could record acts that did not happen, attribute one to a person who did not perform it, and choose the channel - the one field the audit change exists to make unforgeable",
  },
  {
    exported: "AuthService",
    token: "AuthService",
    why: "it resolves a person from request headers, which is the whole of what the connector's own route must not do: that route is Bearer-only, and a connector holding this could read the browser's session cookie inside its own handler and decide by it",
  },
  {
    exported: "PrincipalService",
    token: "PrincipalService",
    why: "it answers what any person may do, which is the question a plugin is supposed to have answered for it rather than ask for itself",
  },
  {
    exported: "AuthorizationGuard",
    token: "AuthorizationGuard",
    why: "it is the decision itself, and a plugin holding the guard could ask it about a request it composed",
  },
  {
    exported: "PrismaService",
    token: "PrismaService",
    why: "it is the whole database, including every statutory register and the encrypted columns the plugin API never offers",
  },
  {
    exported: "FieldEncryptionService",
    token: "FieldEncryptionService",
    why: "it decrypts the columns the register keeps encrypted at rest, which is the protection those columns exist for",
  },
  {
    exported: "MailService",
    token: "MailService",
    why: "the host hands a plugin a narrowed mailer that demands the mail:send permission and stamps the plugin's id on a template of its own; a plugin injecting this one gets neither, and can mail every member through the association's own templates",
  },
  {
    exported: "MailSettingsResolver",
    token: "MailSettingsResolver",
    why: "it resolves the instance's mail with its credentials - the stored SMTP password decrypted, or the key set where the instance runs - so a plugin holding it could send as the association outside the narrowed mailer, or carry the key away",
  },
  {
    exported: "SmsService",
    token: "SmsService",
    why: "the same reach as the mailer, to a channel a member cannot ignore",
  },
  {
    exported: "JobQueueService",
    token: "JobQueueService",
    why: "the host force-prefixes a plugin's queue names with its own id; a plugin injecting this one could enqueue work under a core queue's name",
  },
  {
    exported: "I18nService",
    token: "I18nService",
    why: "a plugin has its own i18n through the host's plugin locale route, and this one carries the platform's resources",
  },
  {
    exported: "CatalogClient",
    token: "CatalogClient",
    why: "it speaks to the catalogue the board installs from, so a plugin holding it acts as the instance towards the place its own successor is fetched from",
  },
  {
    exported: "PackageLock",
    token: "PackageLock",
    why: "it holds the lock an install and an uninstall of one package take, so a plugin holding it could keep the board from installing or removing any plugin or theme, its own successor included, for as long as it liked",
  },
  {
    exported: "ENV",
    token: "OPENBRF_ENV",
    why: "it is the instance's whole configuration, secrets included - and the token is a symbol, so a set of class names could never have refused it",
  },
  {
    exported: "PROTECTED_RESOURCE",
    token: "PROTECTED_RESOURCE",
    why: "it is what the instance publishes about its own protected resource, and the token is a plain string rather than a class",
  },
  /*
   * Not exported by a `@Global()` module. `ActionsModule` is deliberately not
   * global, but `pluginHostBinding` is a module-level singleton provided to the
   * injector as the same object, so a `require()` of the compiled file yields
   * these. They are denied here for the declaration path; the residual reach is
   * recorded in ADR 0008 rather than closed, because a `require` of
   * `@prisma/client` gets a database handle regardless.
   */
  {
    exported: "",
    token: "ActionRegistryService",
    why: "it is dispatch without the plugin's identity attached, so a plugin holding it could register actions as somebody else and invoke as anybody",
  },
  {
    exported: "",
    token: "ActionCallerFactory",
    why: "it composes the caller handle the registry resolves an identity from",
  },
  {
    exported: "",
    token: "CoreActionRegistrar",
    why: "it registers an action as core, which is the owner no plugin's action may carry",
  },
  /*
   * The injector handles, which are the second half of the reach. `@nestjs/core`
   * is a host-shared package and the contract tells plugin authors to declare it
   * as a peer dependency - that list asserts a resolution identity rather than
   * allowing an import - so `moduleRef.get(PrismaService, { strict: false })` is
   * exactly the hole a declaration check would otherwise leave open. Nothing in
   * core injects any of them today, so denying them breaks nothing; an honest
   * plugin that needs dynamic resolution gets a boot finding rather than a
   * crash.
   */
  ...(
    [
      "ModuleRef",
      "ModulesContainer",
      "Reflector",
      "DiscoveryService",
      "LazyModuleLoader",
      "HttpAdapterHost",
    ] as const
  ).map((token) => ({
    exported: "",
    token,
    why: "it resolves any provider in the application by token, which would reach every service on this list without declaring one of them",
  })),
];

/**
 * Root-injector exports a plugin may hold, with the reason each is safe.
 *
 * Empty, and that is the current answer rather than an oversight: every one of
 * the fifteen names the twelve global modules export is either the register,
 * an authority, a channel out of the instance, or a narrowed service the host
 * hands over deliberately. The list exists because the guard script reads both,
 * so a future global export can be classified as safe by somebody willing to
 * write the sentence rather than by nobody noticing it.
 */
export const ALLOWED_INJECTIONS: ReadonlyMap<string, string> = new Map<
  string,
  string
>([]);

const FORBIDDEN_INJECTIONS: ReadonlySet<string> = new Set(
  DENIED_INJECTIONS.map((denied) => denied.token),
);

/** How deep a plugin's own module graph may go before it is refused. */
const MAX_MODULE_DEPTH = 16;

/**
 * How long a prototype chain may be before it is refused.
 *
 * The plugin builds the chain, and a proxy can build one that never ends. No
 * class hierarchy needs a link past this.
 */
const MAX_PROTOTYPE_DEPTH = 64;

/** A refusal found too deep in a read to be returned through every caller. */
class SealRefusal extends Error {}

function prototypeChainTooLong(): SealRefusal {
  return new SealRefusal(
    "A prototype chain in the module graph is longer than " +
      `${String(MAX_PROTOTYPE_DEPTH)} links.`,
  );
}

export interface SealOptions {
  pluginId: string;
  /** The capability floor the plugin's permissions imply. */
  floor: Capability;
}

export type SealResult =
  | { ok: true; module: DynamicModule; controllers: string[] }
  | {
      ok: false;
      reason: "module-invalid" | "module-refused" | "forbidden-injection";
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
  /*
   * Reading the module runs the plugin's code - a getter, a forward
   * reference, a proxy's trap, a class's static `name` - and any of it can
   * throw. What it threw is the plugin's text, so only its name is logged.
   */
  try {
    return sealModule(candidate, options);
  } catch (cause) {
    return { ok: false, reason: "module-refused", log: thrownLog(cause) };
  }
}

function thrownLog(cause: unknown): string {
  try {
    return cause instanceof SealRefusal
      ? cause.message
      : `Reading the module threw ${failureName(cause)}.`;
  } catch {
    // Naming it ran more of the plugin's code, which threw in turn.
    return "Reading the module threw something that could not be named.";
  }
}

function sealModule(candidate: unknown, options: SealOptions): SealResult {
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
  const state: WalkState = {
    controllers,
    seen: new Set<unknown>(),
    depth: 0,
    outcome: {},
  };
  const refusal = walk(candidate, state);
  if (refusal !== null) {
    /*
     * Reaching for a core service the platform never offered is its own
     * reason, because it is the one refusal here that is about what the plugin
     * wanted rather than about how its module was built - and a board reading
     * "it asks for a service a plugin may not hold" can act on that, where
     * "its module was refused" tells them only to ask the author.
     */
    return {
      ok: false,
      reason: state.outcome.refusedFor ?? "module-refused",
      log: refusal,
    };
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
  /**
   * Where a refusal records a reason of its own, rather than the general one.
   *
   * An object rather than a field, because the walk recurses with a SPREAD of
   * this state to carry the depth - so anything written onto the state itself
   * is written onto a copy and lost, exactly as `seen` would be were it not a
   * Set shared by reference. A refusal found three modules down has to reach
   * the caller.
   *
   * The reason it carries: almost every refusal the walk can produce means the
   * same thing to a board, that the module was built in a way a plugin's module
   * may not be. Reaching for a core service is different - it says what the
   * plugin wanted - and a board can act on that.
   */
  outcome: { refusedFor?: "forbidden-injection" };
}

/**
 * The lists of a module the seal reads to find what NestJS will build. `@Module`
 * stores each under the name a dynamic module gives it.
 */
const MODULE_LISTS = [
  "providers",
  "controllers",
  "imports",
] as const satisfies readonly (keyof DynamicModule)[];

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
  // the truth. Truthy rather than `true`, which is the test NestJS applies.
  if (
    isPresent(reflect(moduleClass, GLOBAL_MODULE_METADATA)) ||
    isPresent(dynamic?.global)
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

  // NestJS registers every module class as a provider of its own module and
  // builds it from the same injector, so the class is checked as one.
  const reachedByModule = firstForbidden(classReaches(moduleClass));
  if (reachedByModule !== null) {
    state.outcome.refusedFor = "forbidden-injection";
    return (
      `The module "${moduleClass.name}" reaches ` +
      `${reachedByModule}, which a plugin may not hold.`
    );
  }

  /*
   * NestJS spreads each of these lists, so a set of providers is registered
   * as surely as an array of them. The seal reads only what it can read whole,
   * where anything else would be read as empty and check nothing. Each is read
   * once, so what is checked is what was read.
   */
  const lists: Partial<Record<(typeof MODULE_LISTS)[number], unknown[]>> = {};
  for (const key of MODULE_LISTS) {
    const read: unknown[] = [];
    for (const list of [reflect(moduleClass, key), dynamic?.[key]]) {
      const entries = listed(list);
      if (entries.includes(UNREADABLE)) {
        return (
          `The module "${moduleClass.name}" gives its ${key} as something ` +
          "other than a plain array."
        );
      }
      read.push(...entries);
    }
    lists[key] = read;
  }

  for (const provider of lists.providers ?? []) {
    /*
     * NestJS reads guards, interceptors, filters and pipes from any provider
     * with a prototype, not only from a class. An object provider carrying one
     * would have them built without being a class this reads them from, and
     * no ordinary provider declaration has one.
     */
    if (
      typeof provider === "object" &&
      provider !== null &&
      isPresent((provider as { prototype?: unknown }).prototype)
    ) {
      return (
        `A provider in "${moduleClass.name}" is an object with a prototype, ` +
        "which NestJS would read enhancers from as if it were a class."
      );
    }

    const name = APPLICATION_WIDE_TOKENS.get(providerToken(provider));
    if (name !== undefined) {
      return (
        `The module "${moduleClass.name}" registers an application-wide ` +
        `${name}, which would act on the application's own routes.`
      );
    }

    const reached = forbiddenInjection(provider);
    if (reached !== null) {
      state.outcome.refusedFor = "forbidden-injection";
      return (
        `A provider in "${moduleClass.name}" reaches ` +
        `${reached}, which a plugin may not hold.`
      );
    }
  }

  for (const controller of lists.controllers ?? []) {
    const reached = firstForbidden(classReaches(controller));
    if (reached !== null) {
      state.outcome.refusedFor = "forbidden-injection";
      return (
        `A controller in "${moduleClass.name}" reaches ` +
        `${reached}, which a plugin may not hold.`
      );
    }
    if (!state.controllers.includes(controller)) {
      state.controllers.push(controller);
    }
  }

  for (const imported of lists.imports ?? []) {
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
    for (const { name, handler } of handlers(prototype)) {
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
 * Every method a controller answers on, inherited ones included.
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
 *
 * Read from the property descriptor rather than by name. Reading
 * `prototype[name]` calls a getter, which is the plugin's own code running
 * inside the gate that decides whether the plugin may run at all - and a
 * getter that throws would take the whole boot down, because this is the one
 * path in the load where a plugin's defect is a refusal rather than an
 * exception. A descriptor answers what the property is without evaluating it,
 * so an accessor is skipped: NestJS routes to methods, and a property that has
 * to be called to find out what it holds is not one.
 */
function handlers(prototype: object): { name: string; handler: object }[] {
  const found: { name: string; handler: object }[] = [];
  const seen = new Set<string>(["constructor"]);

  for (
    let current: object | null = prototype, depth = 0;
    current !== null && current !== Object.prototype;
    current = Reflect.getPrototypeOf(current), depth += 1
  ) {
    if (depth === MAX_PROTOTYPE_DEPTH) {
      throw prototypeChainTooLong();
    }
    for (const name of Object.getOwnPropertyNames(current)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const value: unknown = Object.getOwnPropertyDescriptor(
        current,
        name,
      )?.value;
      if (typeof value === "function") {
        found.push({ name, handler: value });
      }
    }
  }

  return found;
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
    // The thunk is the plugin's, so what it threw is the plugin's text and
    // stays out of the refusal, which is written to the log.
    return {
      refusal:
        "A forward reference in the module graph threw " +
        `${failureName(cause)} and could not be resolved.`,
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

/**
 * The first core service a provider declaration would reach, if it reaches one.
 *
 * The whole declaration rather than only its token, because a token is not what
 * the container resolves. `{ provide: "anything", useClass: Sneaky }` is
 * constructed as `Sneaky`, `{ useFactory, inject: [...] }` is handed exactly
 * what `inject` names, and `{ useExisting }` resolves to whatever it aliases -
 * so reading `provide` alone answers a question the container never asks. That
 * matters here rather than in the abstract: twelve of the platform's modules are
 * `@Global()`, which puts everything they export in the root injector where any
 * of these forms would have been given one.
 *
 * `design:paramtypes` is what TypeScript emits for a decorated class and what
 * NestJS itself reads, and `SELF_DECLARED_DEPS_METADATA` is where `@Inject()`
 * puts a token instead. Both are read, because one constructor can mix them.
 *
 * Still only what a declaration DECLARES. A provider that resolves a class at
 * runtime rather than declaring it is not read here, which is why the injector
 * handles are on the denylist: declaring `ModuleRef` is refused, so the runtime
 * path costs a plugin a boot finding rather than nothing at all. It is a
 * narrowing and not a closure, and ADR 0008 records what remains.
 */
function forbiddenInjection(provider: unknown): string | null {
  return firstForbidden(declarationReaches(provider));
}

/** The first denied service among tokens a declaration names, if any. */
function firstForbidden(tokens: readonly unknown[]): string | null {
  for (const entry of tokens) {
    if (entry === UNREADABLE) {
      return "injection metadata that could not be read as NestJS reads it";
    }
    const reached = resolveInjectionToken(entry);
    if (reached === UNRESOLVED) {
      return "a forward reference that could not be resolved";
    }
    const name = tokenNames(reached).find((each) =>
      FORBIDDEN_INJECTIONS.has(each),
    );
    if (name !== undefined) {
      return name;
    }
  }
  return null;
}

/**
 * What a token is called, in the one spelling the denylist is written in.
 *
 * Three kinds, because NestJS accepts three. A class is its own token and
 * carries a name. A symbol carries a description and nothing else - `ENV` is
 * `Symbol("OPENBRF_ENV")` - and a string token is the string. Reading only the
 * first of the three is what let two names sit on the denylist for a release
 * without ever being able to match: neither `ENV` nor `PROTECTED_RESOURCE` is a
 * function, so the old check passed straight over both.
 *
 * A class answers with every name on its prototype chain, because a subclass is
 * constructed as its base is: `class Db extends PrismaService {}` is the whole
 * database under a name the denylist never wrote down.
 *
 * Empty for anything else, which is every token that cannot be one of ours: an
 * object, a number, undefined. A token with no description is empty for the
 * same reason - `Symbol()` names nothing, so it names nothing on this list
 * either.
 */
function tokenNames(token: unknown): string[] {
  if (typeof token === "function") {
    const names: string[] = [];
    for (
      let current: unknown = token, depth = 0;
      typeof current === "function" && current !== Function.prototype;
      current = Reflect.getPrototypeOf(current), depth += 1
    ) {
      if (depth === MAX_PROTOTYPE_DEPTH) {
        throw prototypeChainTooLong();
      }
      names.push(current.name);
    }
    return names;
  }
  if (typeof token === "symbol") {
    return token.description === undefined ? [] : [token.description];
  }
  if (typeof token === "string") {
    return [token];
  }
  return [];
}

/** A forward reference whose thunk would not produce a token. */
const UNRESOLVED = Symbol("openbrf.unresolvedForwardReference");

/**
 * Injection metadata the seal cannot read the way NestJS will.
 *
 * Refused rather than passed over, for the reason an unresolved forward
 * reference is: what the seal cannot read, it cannot vouch for.
 */
const UNREADABLE = Symbol("openbrf.unreadableInjectionMetadata");

/**
 * A token as the container will finally see it.
 *
 * `forwardRef(() => X)` is `{ forwardRef: thunk }`, and NestJS calls the thunk
 * when it resolves the dependency. Left wrapped, the name check never sees X -
 * and both metadata paths carry the wrapper unchanged:
 * `@Inject(forwardRef(() => PrismaService))` writes it into the self-declared
 * list, and `inject: [forwardRef(() => AuditLogService)]` puts it straight in
 * the array. Both are ordinary NestJS, so the check has to follow them.
 *
 * A thunk that throws is refused rather than passed over, on the same footing
 * as `resolveForwardReference` gives a module import: a reference this cannot
 * resolve is one whose target it cannot vouch for. The chain is followed rather
 * than unwrapped once, because a thunk may return another forward reference,
 * and the bound is what stops one that returns itself.
 */
function resolveInjectionToken(token: unknown): unknown {
  let held = token;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof held !== "object" || held === null) {
      return held;
    }
    const thunk = (held as { forwardRef?: unknown }).forwardRef;
    if (typeof thunk !== "function") {
      return held;
    }
    try {
      held = (thunk as () => unknown)();
    } catch {
      // The thunk is the plugin's, so what it threw is the plugin's text and
      // stays out of the refusal, which is written to the log.
      return UNRESOLVED;
    }
  }
  return UNRESOLVED;
}

/** Every token one provider declaration names, in any of NestJS's forms. */
function declarationReaches(provider: unknown): unknown[] {
  if (typeof provider === "function") {
    // A bare class is both the token and what is constructed.
    return [provider, ...classReaches(provider)];
  }
  if (typeof provider !== "object" || provider === null) {
    return [];
  }

  const declaration = provider as {
    provide?: unknown;
    useClass?: unknown;
    useExisting?: unknown;
    inject?: unknown;
  };
  const reached: unknown[] = [];

  /*
   * NestJS reads the enhancers of a bare class provider only, but checking
   * these two as well costs nothing and does not lean on that detail.
   */
  if (typeof declaration.provide === "function") {
    reached.push(declaration.provide, ...classReaches(declaration.provide));
  }
  if (typeof declaration.useClass === "function") {
    // What is actually constructed when the token is not the class itself.
    reached.push(declaration.useClass, ...classReaches(declaration.useClass));
  }
  if (declaration.useExisting !== undefined) {
    // An alias resolves to what it names, so naming one is holding it.
    reached.push(declaration.useExisting);
  }
  // A factory's arguments, resolved exactly as a constructor's are. NestJS
  // reads them with `Array.from`, which takes any iterable.
  reached.push(...listed(declaration.inject).flatMap(injectedTokens));
  return reached;
}

/**
 * What the container hands a class when it builds one: its constructor's
 * parameters and the fields it marked with `@Inject()`.
 *
 * The fields are the half a constructor check never sees. NestJS assigns them
 * after construction from `PROPERTY_DEPS_METADATA`, from the same root
 * injector, so `@Inject(PrismaService) private db` is as much a reach as the
 * constructor parameter it replaces.
 */
function constructorReaches(token: unknown): unknown[] {
  if (typeof token !== "function") {
    return [];
  }
  /*
   * One token per parameter, as the container picks it: the `@Inject()` token
   * where the parameter has one, the design type otherwise. A parameter typed
   * `PrismaService` but injected as `"plugin-local"` is handed the latter, so
   * counting both would refuse a class that never asks for the database.
   *
   * Built the way NestJS builds it (`Injector.reflectConstructorParams`): the
   * design types copied into an array, then every self-declared entry written
   * over it with a plain `parameters[index] = param`. The assignment is the
   * point. NestJS does not check that `index` is a number, so `{ index: "0" }`
   * replaces parameter 0 exactly as `{ index: 0 }` does, and a check that kept
   * only numbers would have read the design type the container never uses.
   */
  const parameters: unknown[] = [];
  const designed = positioned(reflect(token, "design:paramtypes"));
  if (designed === UNREADABLE) {
    // Refused here rather than carried, where an entry below could write over
    // it while NestJS still resolves the rest of what it would have held.
    return [UNREADABLE];
  }
  for (const [index, type] of designed) {
    parameters[index] = type;
  }
  for (const entry of listed(reflect(token, SELF_DECLARED_DEPS_METADATA))) {
    if (entry === UNREADABLE) {
      return [UNREADABLE];
    }
    if (typeof entry !== "object" || entry === null) {
      // NestJS destructures the entry, which fails the boot for these.
      continue;
    }
    const { index, param } = entry as { index?: unknown; param?: unknown };
    if (!isParameterIndex(index)) {
      /*
       * Anything but a position writes somewhere else: an object's position
       * is its own `toString` to say, `"length"` throws, and `"__proto__"`
       * replaces the prototype NestJS later iterates the array through.
       */
      return [UNREADABLE];
    }
    parameters[Number(index)] = param;
  }

  return [
    // What `Array.from` keeps: the array's elements, and no other key a
    // non-numeric index wrote onto it.
    ...arrayIndexes(parameters).map((index) => parameters[index]),
    ...listed(reflect(token, PROPERTY_DEPS_METADATA)).map((entry) =>
      entry === UNREADABLE
        ? entry
        : typeof entry === "object" && entry !== null
          ? (entry as { type?: unknown }).type
          : undefined,
    ),
  ];
}

/**
 * The positions an array holds a value at, in ascending order.
 *
 * Read from its keys rather than counted up to its length, because a plugin
 * that writes index 4294967294 gives the array a length of four billion and a
 * loop over it would hold the boot for as long as it took. Every key, not only
 * the enumerable ones: NestJS walks to the length, and a position is visited
 * whether or not it would be listed.
 */
function arrayIndexes(array: readonly unknown[]): number[] {
  return Object.getOwnPropertyNames(array).filter(isArrayIndex).map(Number);
}

function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}

/** A self-declared index that names an array position, as a number or a string. */
function isParameterIndex(index: unknown): boolean {
  return typeof index === "number"
    ? Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1
    : typeof index === "string" && isArrayIndex(index);
}

/** Where a class names another class the container builds alongside it. */
const ENHANCER_METADATA = [
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PIPES_METADATA,
  EXCEPTION_FILTERS_METADATA,
] as const;

/**
 * Every token a class the container builds would be handed, its own and its
 * enhancers'.
 *
 * One reading for every class a plugin's module puts in front of the injector:
 * the module class itself, which NestJS registers as a provider of its own
 * module, every provider class and every controller. Their constructors and
 * fields reach as far as a provider's do. So does a guard, interceptor, pipe or
 * filter one of them names by class - `@UseGuards(Sneaky)` has the container
 * construct `Sneaky` with whatever it asks for, at class or at handler level -
 * and a pipe given to one parameter (`@Body(Sneaky)`). NestJS reads those on a
 * provider exactly as on a controller (`DependenciesScanner
 * .reflectDynamicMetadata`), so a provider that serves no route builds them all
 * the same. One given as an instance was built by the plugin itself and is
 * handed nothing.
 */
function classReaches(target: unknown): unknown[] {
  if (typeof target !== "function") {
    return [];
  }
  const enhancers: unknown[] = ENHANCER_METADATA.flatMap((key) =>
    listed(reflect(target, key)),
  );
  const prototype: unknown = target.prototype;
  if (typeof prototype === "object" && prototype !== null) {
    for (const { name, handler } of handlers(prototype)) {
      for (const key of ENHANCER_METADATA) {
        enhancers.push(...listed(reflect(handler, key)));
      }
      const parameters: unknown = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        target,
        name,
      );
      if (!isPresent(parameters)) {
        continue;
      }
      /*
       * NestJS flattens each parameter's `pipes` one level, so a single class
       * written there rather than in a list is built all the same.
       */
      for (const parameter of Object.values(
        parameters as object,
      ) as unknown[]) {
        const pipes =
          typeof parameter === "object" && parameter !== null
            ? (parameter as { pipes?: unknown }).pipes
            : undefined;
        enhancers.push(...(Array.isArray(pipes) ? listed(pipes) : [pipes]));
      }
    }
  }
  return [
    ...constructorReaches(target),
    ...enhancers.flatMap((enhancer) =>
      enhancer === UNREADABLE
        ? [enhancer]
        : typeof enhancer === "function"
          ? [enhancer, ...constructorReaches(enhancer)]
          : [],
    ),
  ];
}

/**
 * A metadata list as NestJS reads it: `Reflect.getMetadata(key) || []`.
 *
 * Absent is empty, as it is for NestJS. Anything else that is not an array is
 * refused rather than read as empty, because NestJS goes on to iterate it - a
 * `Set` of tokens works there - and the seal would have checked nothing.
 */
function listed(value: unknown): unknown[] {
  const entries = positioned(value);
  return entries === UNREADABLE
    ? [UNREADABLE]
    : entries.map(([, entry]) => entry);
}

/**
 * A metadata list's entries with the positions they sit at, or `UNREADABLE`.
 *
 * Only a plain array is read. NestJS walks these lists with its own calls -
 * spread, `forEach`, `map`, `flat` - and an array that brings its own iterator
 * or methods, reads through a getter or a proxy, or inherits from anything
 * else could hand NestJS what the seal never saw. Decorators and compiled
 * design types only ever write plain arrays.
 */
function positioned(
  value: unknown,
): Array<[number, unknown]> | typeof UNREADABLE {
  if (!isPresent(value)) {
    return [];
  }
  if (!isPlainArray(value)) {
    return UNREADABLE;
  }
  return arrayIndexes(value).map((index) => [index, value[index]]);
}

/** An array holding nothing but its length and values at its positions. */
function isPlainArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false;
  }
  return Reflect.ownKeys(value).every(
    (key) =>
      key === "length" ||
      (typeof key === "string" &&
        isArrayIndex(key) &&
        "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {})),
  );
}

/** Truthy, which is the test NestJS's `|| []` applies. */
function isPresent(value: unknown): boolean {
  return Boolean(value);
}

/**
 * The tokens one inject entry can resolve to: a token, or `{ token, optional }`
 * around one.
 *
 * NestJS takes `token` out of the wrapper only when `optional` is set, and
 * otherwise resolves the entry itself - through its `forwardRef`, where it has
 * one. Both are checked rather than that rule repeated, because one more token
 * checked refuses nothing an honest factory asks for.
 */
function injectedTokens(entry: unknown): unknown[] {
  return typeof entry === "object" && entry !== null && "token" in entry
    ? [(entry as { token: unknown }).token, entry]
    : [entry];
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

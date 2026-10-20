import { types } from "node:util";

import {
  type DynamicModule,
  type ExecutionContext,
  type INestApplicationContext,
  RequestMethod,
  type Type,
} from "@nestjs/common";
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
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  ApplicationConfig,
  ModuleRef,
  NestContainer,
} from "@nestjs/core";
import { RoutePathFactory } from "@nestjs/core/router/route-path-factory";

import type { Capability } from "../authorization/capabilities";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { patternReaches } from "../devices/device-routes";
import { failureName, identifier } from "../logging/failure";

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
 *   own global guard is what enforces the result. Every forward reference the
 *   seal follows is fixed to what it resolved to, and one in a dynamic
 *   module's imports is replaced by it, so NestJS is handed the module the
 *   seal checked.
 *
 *   What is read. Only what gives NestJS the same answer the seal was given:
 *   a field held as a data property, a list held as a plain array. A getter, a
 *   proxy or a list with its own way of being read is refused, because it can
 *   answer each read differently. That holds for the lists a controller's
 *   routes are mounted and authorized by, which the router and the guard read
 *   after the seal. A class's name is read the same way only for the log, so
 *   a name behind a getter is not run and is logged as "(unnamed)", not
 *   refused: NestJS reads a module's name itself when it builds the module.
 *
 *   What is kept as read. The plugin's code runs again after a read: a forward
 *   reference's thunk while the seal is still reading, and anything the
 *   plugin's factory scheduled once it has returned. So every list the seal
 *   reads, and every declaration it reads a field of, is frozen as it is read,
 *   a dynamic module's fields are fixed to it, and what it read of a class,
 *   which cannot be frozen, is read again at the end of the seal, before the
 *   application is built and once it is built (`rereadSealedModule`), and
 *   compared with what the seal first read of it. The plugin's code also runs
 *   while NestJS builds the module, and can undo a change before the build is
 *   over, so what NestJS built from it is compared with what the seal read as
 *   well (`sealModuleInstances`), down to each controller's instance, which is
 *   what NestJS serves the routes of.
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
   * Not exported by a `@Global()` module. `ActionsModule` and `DevicesModule`
   * are deliberately not global, and the device token resolver is provided in
   * a global module without being exported, but `pluginHostBinding` is a
   * module-level singleton provided to the injector as the same object, so a
   * `require()` of the compiled file yields these. They are denied here for the declaration path; the residual reach is
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
    token: "DeviceTokenService",
    why: "it issues and revokes device tokens for any plugin's routes, without the plugin's identity or the board's act attached (ADR 0031)",
  },
  {
    exported: "",
    token: "DeviceTokenResolver",
    why: "it reads which device a token belongs to, which is the guard's decision about a device route and not a plugin's",
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

function proxyOnChain(): SealRefusal {
  return new SealRefusal(
    "A prototype chain in the module graph runs through a proxy or a getter, " +
      "which can answer each read differently.",
  );
}

/** The refusal for a field the seal could not read without running the plugin's code. */
function unreadableField(owner: string, key: string): string {
  return (
    `${owner} keeps its \`${key}\` behind a getter or a proxy, which can ` +
    "answer each read differently."
  );
}

/** The refusal for a list the seal reads that is not a plain array. */
function notPlainList(owner: string, list: string): string {
  return `${owner} gives its ${list} as something other than a plain array.`;
}

/** The refusal for a class in the graph that is a proxy, before anything is read from it. */
function proxiedClass(owner: string): string {
  return `${owner} is a proxy, which can answer each read differently.`;
}

/**
 * A name the plugin chose, as the log may repeat it.
 *
 * The log is plain text, and a name with a newline in it would write a log
 * entry of the plugin's own, so only what `identifier` keeps of it is used.
 */
function named(name: unknown): string {
  return (typeof name === "string" && identifier(name)) || "(unnamed)";
}

/**
 * A class's name for the log, read as a data property so that no getter or
 * proxy of the plugin's runs to supply it.
 */
function nameOf(target: object): string {
  return named(field(target, "name"));
}

/** The longest stretch of a declared path the log repeats. */
const MAX_PATH_TEXT = 120;

/**
 * What `JSON.stringify` leaves as it is but a reader of the log may take for
 * the end of a line: the C1 controls, NEL among them, and the Unicode line
 * and paragraph separators.
 */
const LINE_BREAKING = /[\u007f-\u009f\u2028\u2029]/g;

/**
 * A path the plugin declared, for the log. Only a string is quoted, escaped
 * onto one line; anything else is named by its type, because writing out an
 * object would run its `toJSON`.
 */
function pathText(path: unknown): string {
  return typeof path === "string"
    ? JSON.stringify(path.slice(0, MAX_PATH_TEXT)).replaceAll(
        LINE_BREAKING,
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
    : `(${typeof path})`;
}

/** The most paths of one controller the log repeats. */
const MAX_LOGGED_PATHS = 10;

/**
 * The paths a controller was sealed onto, as the boot log repeats them.
 *
 * A path the seal accepts may still hold a newline or run to any length, and
 * the log is plain text, so each is escaped onto one line and cut short, as a
 * refused path is by `pathText`. Only this text is shortened: the paths
 * written onto the controller are the ones routing reads.
 */
function loggedPaths(paths: readonly string[]): string {
  const shown = paths
    .slice(0, MAX_LOGGED_PATHS)
    .map((path) => pathText(path).slice(1, -1));
  if (paths.length > MAX_LOGGED_PATHS) {
    shown.push(`... and ${paths.length - MAX_LOGGED_PATHS} more`);
  }
  return shown.join(", ");
}

export interface SealOptions {
  pluginId: string;
  /** The capability floor the plugin's permissions imply. */
  floor: Capability;
  /**
   * The absolute paths of the plugin's device routes (ADR 0031). A route that
   * could answer a request under one with any method but GET or HEAD is
   * refused.
   */
  deviceRoutes?: readonly string[];
  /**
   * The source text of the plugin's server entry, the file the host required.
   * A base class of a controller is frozen with it when this defines it
   * (`pluginBases`).
   */
  source: string;
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
   * Reading the module still runs the plugin's code where a forward
   * reference has to be resolved, and that can throw. What it threw is the
   * plugin's text, so only its name is logged.
   */
  const reads: Reads = new Map();
  // Restored rather than cleared, so that a seal begun inside another leaves
  // the outer one still keeping what it reads.
  const outer = reading;
  reading = reads;
  try {
    return sealModule(candidate, options, reads);
  } catch (cause) {
    return { ok: false, reason: "module-refused", log: thrownLog(cause) };
  } finally {
    reading = outer;
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

function sealModule(
  candidate: unknown,
  options: SealOptions,
  reads: Reads,
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
  const modules: unknown[] = [];
  const provided = new Map<unknown, Set<unknown>>();
  const state: WalkState = {
    controllers,
    modules,
    provided,
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
  const classes = new Map<unknown, SealedClass>();

  for (const controller of controllers) {
    const sealed = sealController(controller, prefix, options);
    if (!sealed.ok) {
      return { ok: false, reason: "module-refused", log: sealed.log };
    }
    names.push(sealed.path);
    classes.set(controller, {
      prototype: sealed.prototype,
      bases: sealed.bases,
      routes: sealed.routes,
    });
  }

  /*
   * A thunk the seal called ran after the reads before it, and a class it
   * changed is not frozen, so all of them are read once more.
   */
  const changed = changedRead(reads);
  if (changed !== null) {
    return { ok: false, reason: "module-refused", log: changed };
  }

  SEALED_MODULES.set(candidate, {
    pluginId: options.pluginId,
    classes: modules,
    provided,
    controllers,
    controllerClasses: classes,
    reads,
  });
  return { ok: true, module: candidate, controllers: names };
}

/** What the seal kept of a module it let through. */
interface Sealed {
  /** The plugin it was sealed for. */
  readonly pluginId: string;
  /** The module classes, for `sealModuleInstances`. */
  readonly classes: readonly unknown[];
  /** The provider tokens it read, by the module class it read them for. */
  readonly provided: ReadonlyMap<unknown, ReadonlySet<unknown>>;
  /** The controllers it sealed. */
  readonly controllers: readonly unknown[];
  /**
   * What it read of each controller's class, by controller, for the instance
   * `sealModuleInstances` finds built from it.
   */
  readonly controllerClasses: ReadonlyMap<unknown, SealedClass>;
  /** Everything it read, for `rereadSealedModule`. */
  readonly reads: Reads;
}

/** What the seal read of a controller's class. */
interface SealedClass {
  /** The prototype it read the routes of. */
  readonly prototype: object;
  /** The prototypes further down its chain the plugin's entry defines. */
  readonly bases: ReadonlySet<object>;
  /** Each route it sealed, with the method it read for it. */
  readonly routes: readonly SealedRoute[];
}

/** A method on a controller's prototype chain, by the name it is found under. */
interface Method {
  readonly name: string;
  readonly handler: object;
}

/** A route the seal sealed, with what it checked of it. */
interface SealedRoute extends Method {
  readonly checked: CheckedRoute;
}

const SEALED_MODULES = new WeakMap<object, Sealed>();

/**
 * A route of a plugin's controller as the seal checked it: where the router
 * mounts it and what a request to it needs.
 */
export interface CheckedRoute {
  /** Each path the router mounts it on, spelled as the router spells it. */
  readonly paths: ReadonlySet<string>;
  /** The request methods it answers, or null for every method. */
  readonly methods: ReadonlySet<string> | null;
  /**
   * The capabilities a request to it needs: the route's own and its class's,
   * the plugin's floor among them, as the seal wrote them.
   */
  readonly capabilities: readonly Capability[];
}

/** A plugin controller whose instance was fixed as it was checked. */
export interface FixedController {
  /** The plugin whose module it was sealed in. */
  readonly pluginId: string;
  /** Each route the instance was fixed to, by the method it calls. */
  readonly routes: ReadonlyMap<unknown, CheckedRoute>;
}

const FIXED_CONTROLLERS = new WeakMap<object, FixedController>();

/**
 * The plugin and the routes a controller's instance was fixed to, or undefined
 * for a class whose instance the seal never fixed, which is any controller of
 * the application's own.
 *
 * The seal keeps the method it fixed under each route it checked
 * (`sealControllerInstance`), what it checked of that route, and the plugin the
 * module was sealed for. Held apart from the class's metadata.
 */
export function fixedController(
  controller: unknown,
): FixedController | undefined {
  return isRecord(controller) ? FIXED_CONTROLLERS.get(controller) : undefined;
}

/** What `checkedRoute` reads of a request: what the router matched it to. */
interface RoutedRequest {
  readonly method?: unknown;
  readonly routeOptions?: { readonly url?: unknown };
}

/**
 * The route the seal checked that a request reached, or undefined when it
 * reached a controller the seal never fixed, or a plugin's controller some
 * other way.
 *
 * A request has reached a checked route when the method it reached is the one
 * the seal fixed under that route, the router matched it on a path the seal
 * recorded for it, and its request method is one the route answers. The guard
 * that keeps a plugin's routes answering serves a plugin's controller only
 * through a checked route, and the authorization guard authorizes a checked
 * route by what the seal recorded of it.
 */
export function checkedRoute(
  context: ExecutionContext,
): CheckedRoute | undefined {
  const route = fixedController(context.getClass())?.routes.get(
    context.getHandler(),
  );
  if (route === undefined || context.getType() !== "http") {
    return undefined;
  }
  const { method, routeOptions } = context
    .switchToHttp()
    .getRequest<RoutedRequest>();
  const path = routeOptions?.url;
  return typeof path === "string" &&
    route.paths.has(path) &&
    typeof method === "string" &&
    (route.methods === null || route.methods.has(method))
    ? route
    : undefined;
}

/**
 * One read the seal made, so that it can be made again.
 *
 * Freezing keeps a list or a declaration as it was read, but a class cannot be
 * frozen: the plugin's own code gives it statics, and its metadata is held
 * apart from it, where `Reflect.defineMetadata` replaces it whatever the class
 * is. So each field and each metadata entry the seal read is kept with what it
 * held, and read again where the plugin's code could have run since.
 */
interface Read {
  /** What the log names: a field or a metadata key. */
  readonly key: string;
  /** The method a metadata key is read for, where it is read for one. */
  readonly on?: string | undefined;
  readonly value: unknown;
  /** The same read, made without running the plugin's code. */
  readonly again: () => unknown;
  /** Compared entry by entry: a list the seal composed rather than read whole. */
  readonly composed?: true;
}

/** A seal's reads, by what they were read from and then by what was read. */
type Reads = Map<object, Map<string, Read>>;

/** The reads of the seal in progress, or null outside one. */
let reading: Reads | null = null;

/**
 * Keeps one read of the seal in progress.
 *
 * Only the first read of a thing is kept. The seal reads some things twice -
 * a controller's methods, for the enhancers they name and then for their
 * paths - and a thunk can run in between. Were the later read kept, what the
 * first one was checked for would be lost: a method only the later read saw
 * would be mounted with enhancers nobody checked. So a later read that differs
 * is a change, found when the reads are made again (`changedRead`). Only what
 * the seal writes itself replaces what it expects (`expectWritten`).
 */
function remember(from: object, slot: string, read: Read): void {
  if (reading === null) {
    return;
  }
  let reads = reading.get(from);
  if (reads === undefined) {
    reads = new Map();
    reading.set(from, reads);
  }
  if (!reads.has(slot)) {
    reads.set(slot, read);
  }
}

/**
 * Makes a read of something the seal has just written itself the one expected
 * of it from then on: a rewritten controller's metadata, or a forward
 * reference fixed to what it resolved to. `read` reads it back.
 */
function expectWritten(from: object, slot: string, read: () => unknown): void {
  reading?.get(from)?.delete(slot);
  read();
}

function fieldSlot(key: string): string {
  return `field:${key}`;
}

function metadataSlot(key: string, property: string | undefined): string {
  return `metadata:${key}:${property ?? ""}`;
}

/**
 * The first read that no longer gives what the seal was given, as the
 * refusal, or null when every one still does.
 *
 * Nothing read here is kept: a read made again would otherwise be kept in
 * place of the one it is compared with, and a change would be expected.
 */
function changedRead(reads: Reads): string | null {
  const kept = reading;
  reading = null;
  try {
    return firstChangedRead(reads);
  } finally {
    reading = kept;
  }
}

function firstChangedRead(reads: Reads): string | null {
  for (const [from, each] of reads) {
    for (const read of each.values()) {
      const now = read.again();
      const same = read.composed
        ? Array.isArray(now) &&
          Array.isArray(read.value) &&
          now.length === read.value.length &&
          now.every((entry, index) =>
            Object.is(entry, (read.value as unknown[])[index]),
          )
        : Object.is(now, read.value);
      if (!same) {
        const owner =
          typeof from === "function"
            ? `"${nameOf(from)}"`
            : "A declaration in the module graph";
        const what =
          read.on === undefined
            ? `its \`${read.key}\``
            : `the \`${read.key}\` of its \`${named(read.on)}\``;
        return (
          `${owner} changed ${what} after the seal read it, so NestJS ` +
          "would not build what was checked."
        );
      }
    }
  }
  return null;
}

/**
 * Reads again everything the seal read of a module, and explains what changed
 * since, or returns null when nothing did.
 *
 * The plugin's code can run between the seal and the build - a timer or a
 * promise its factory left behind - and while NestJS builds the module. What
 * the seal froze stays as it was read; what it could not freeze, a class's
 * metadata and its fields, is read here. The application calls this before it
 * builds the module, and `sealModuleInstances` calls it once it is built.
 *
 * Never throws, for the reason `sealPluginModule` never does.
 */
export function rereadSealedModule(sealed: DynamicModule): string | null {
  try {
    const kept = SEALED_MODULES.get(sealed);
    if (kept === undefined) {
      return "The module was not sealed before the application was built.";
    }
    return changedRead(kept.reads);
  } catch (cause) {
    return thrownLog(cause);
  }
}

/**
 * Freezes a declaration the seal is about to read, so that NestJS reads what
 * the seal read however often the plugin's code runs afterwards.
 *
 * A class is left as it is: it is the plugin's, and its own code may write to
 * it. What the seal reads of one is read again instead (`changedRead`). A
 * proxy is left too, because freezing one runs its traps; every field read of
 * a proxy is refused.
 */
function fix(record: object): void {
  if (typeof record === "object" && !types.isProxy(record)) {
    Object.freeze(record);
  }
}

/**
 * Fixes the fields of a module reference the seal is about to read, each to
 * the value it holds, or returns false where one cannot be fixed.
 *
 * Not frozen, as a declaration is (`fix`): NestJS writes a key of its own onto
 * every module reference it registers, and fails the build on one that takes
 * no new key. A field the reference does not hold itself is not fixed, and is
 * read again instead (`changedRead`). A proxy is left to be refused when it is
 * read.
 */
function fixFields(record: object, keys: readonly string[]): boolean {
  if (types.isProxy(record)) {
    return true;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return true;
    }
    return Reflect.defineProperty(record, key, {
      value: descriptor.value,
      writable: false,
      enumerable: descriptor.enumerable ?? true,
      configurable: false,
    });
  });
}

/** One module of a built application, as NestJS's container holds it. */
export interface BuiltModule {
  /**
   * The key NestJS registered the module under. A class it is handed as
   * itself is registered once, and each dynamic module apart, so two modules
   * of one class are told apart by it.
   */
  readonly token: string;
  readonly metatype: unknown;
  readonly instance: unknown;
  readonly isGlobal: boolean;
  readonly imports: ReadonlySet<BuiltModule>;
  /** By token, as NestJS registered each. */
  readonly providers: ReadonlyMap<unknown, BuiltInstance>;
  readonly controllers: ReadonlyMap<unknown, BuiltInstance>;
  /** The guards, interceptors, filters and pipes its classes name. */
  readonly injectables: ReadonlyMap<unknown, BuiltInstance>;
}

/** A provider, controller or enhancer of a built module. */
export interface BuiltInstance {
  /** The object NestJS built once, for a controller the one it serves. */
  readonly instance: unknown;
  /** Whether NestJS builds one for each class it is injected into. */
  readonly isTransient: boolean;
  /** False where it, or anything it depends on, is built for each request. */
  isDependencyTreeStatic(): boolean;
  /** What NestJS resolved each constructor parameter to. */
  getCtorMetadata(): readonly (BuiltDependency | undefined)[] | undefined;
  /** What NestJS resolved each injected field to. */
  getPropertiesMetadata():
    readonly { readonly wrapper: BuiltDependency }[] | undefined;
}

interface BuiltDependency {
  readonly token: unknown;
}

/**
 * Checks what NestJS built from a sealed module, and the instances its classes
 * were built into, and fixes each instance to registering no middleware, or
 * explains why the plugin is refused.
 *
 * NestJS asks a module's instance for `configure`, not its class, and the seal
 * can only read the class. Building the instance runs the plugin's code - a
 * constructor, a field's initialiser, a base class's constructor - and any of
 * it can give the instance a `configure` its prototype never had. So each
 * instance is read once the application is built and before it is initialised,
 * which is when NestJS asks, and given a `configure` of nothing, read-only and
 * not configurable, so nothing the plugin runs afterwards can give it one.
 *
 * Building the application runs the plugin's code too, so what the seal read
 * of the module is read again first (`rereadSealedModule`), and what NestJS
 * built from it is compared with what the seal read (`changedBuild`). Each
 * controller instance is checked there, and then fixed as it was checked, as a
 * module instance is (`sealControllerInstance`).
 *
 * Called with every module of the application; only the sealed module's own
 * are read. `host` is the keys of the application's own modules
 * (`hostModules`), which a plugin's module may import. Never throws, for the
 * reason `sealPluginModule` never does.
 */
export function sealModuleInstances(
  sealed: DynamicModule,
  built: Iterable<BuiltModule>,
  host: ReadonlySet<string> = new Set(),
): string | null {
  try {
    const kept = SEALED_MODULES.get(sealed);
    if (kept === undefined) {
      return "The module was not sealed before the application was built.";
    }
    const changed = changedRead(kept.reads);
    if (changed !== null) {
      return changed;
    }
    const modules = [...built];
    const rebuilt = changedBuild(kept, modules, host);
    if (rebuilt !== null) {
      return rebuilt;
    }
    for (const module of modules) {
      if (kept.classes.includes(module.metatype)) {
        const refusal = sealModuleInstance(module);
        if (refusal !== null) {
          return refusal;
        }
      }
    }
    return null;
  } catch (cause) {
    return thrownLog(cause);
  }
}

/**
 * The modules an application declares itself, from its root module down, as
 * the classes and dynamic modules it imports them as, for `hostModules`.
 *
 * Read from the application's own module decorators, which only its own code
 * writes, and never from what NestJS built: the container cannot tell a module
 * the application imports from one a plugin's code brought in while it was
 * built, because NestJS links every global module into every other. A module
 * held as anything but a class or a dynamic module's data fields is not
 * followed, so a module NestJS builds from one reads as a module nobody
 * sealed, and a plugin that reaches it is refused rather than let through.
 */
export function declaredModules(root: object): readonly unknown[] {
  const declared: unknown[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    const dynamic = typeof entry === "object" && entry !== null;
    const type = dynamic ? readField(entry, "module") : entry;
    if (typeof type !== "function") {
      continue;
    }
    declared.push(entry);
    for (const imports of [
      Reflect.getMetadata("imports", type) as unknown,
      dynamic ? readField(entry, "imports") : undefined,
    ]) {
      if (Array.isArray(imports)) {
        pending.push(...(imports as unknown[]));
      }
    }
  }
  return declared;
}

/**
 * The keys NestJS registered the application's own modules under, from what
 * the application declares (`declaredModules`), for `sealModuleInstances`.
 *
 * Not their classes. NestJS registers a class it is handed as itself once and
 * each dynamic module apart, so a dynamic module of one of the application's
 * classes is a module of its own, with whatever providers it was given, and
 * one the application never declared is not the application's for sharing its
 * class. Each declaration is put to the application's own module compiler,
 * which answers with the key NestJS registered it under, so a module is the
 * application's when NestJS itself would have taken it for the declared one.
 * NestJS's own core module is added as NestJS registered it: it builds it
 * into every application.
 *
 * The container is read from the application, which does not offer it. Where
 * it cannot be read, no module is the application's, and every plugin is
 * refused rather than let through. Never throws.
 */
export async function hostModules(
  declared: readonly unknown[],
  application: INestApplicationContext,
): Promise<ReadonlySet<string>> {
  try {
    const container: unknown = Reflect.get(application, "container");
    if (!(container instanceof NestContainer)) {
      return new Set();
    }
    const compiler = container.getModuleCompiler();
    const host = new Set<string>();
    for (const declaration of declared) {
      host.add((await compiler.compile(declaration as Type)).token);
    }
    const core = container.getInternalCoreModuleRef();
    if (core !== undefined) {
      host.add(core.token);
    }
    return host;
  } catch {
    return new Set();
  }
}

/**
 * The first way what NestJS built from a sealed module differs from what the
 * seal read of it, or null when it is what was read.
 *
 * The reads are made again before the build and once it is built, but NestJS
 * runs the plugin's code while it builds the module too - a name it reads, a
 * constructor - and a change made there and undone before the build is over
 * leaves nothing for a read to find. What it built stays built, so that is
 * what is read here: the modules the plugin's own modules import, whether any
 * of them is global, the providers and controllers each holds, what each of
 * those was given to be constructed with, and what each controller was built
 * into (`sealControllerInstance`).
 *
 * A module is the application's by the key it was registered under, not by
 * its class (`hostModules`). Any other module of a class the seal read is the
 * plugin's and is compared, and one of a class it did not read is refused
 * where a plugin's module imports it.
 *
 * A provider is compared as one the seal read, rather than the lists as
 * equal: one NestJS did not build gives the plugin nothing, where one the seal
 * did not read is the change that matters.
 *
 * A global module nobody sealed is linked into every plugin's modules alike,
 * so it cannot be traced to the plugin whose code brought it in. Each plugin
 * that reaches it is refused, the first first, and the application is built
 * again until it is gone: a plugin may be refused for another's module, but
 * none is served beside it.
 */
function changedBuild(
  kept: Sealed,
  built: readonly BuiltModule[],
  host: ReadonlySet<string>,
): string | null {
  const own = (module: BuiltModule): boolean =>
    !host.has(module.token) && kept.classes.includes(module.metatype);
  for (const read of kept.classes) {
    if (!built.some((module) => module.metatype === read)) {
      return (
        `${moduleOwner(read)} was read by the seal and not built, so NestJS ` +
        "did not build what was checked."
      );
    }
  }
  for (const module of built) {
    if (!own(module)) {
      continue;
    }
    const refusal = changedModule(kept, module);
    if (refusal !== null) {
      return refusal;
    }
    for (const imported of module.imports) {
      if (!own(imported) && !host.has(imported.token)) {
        return (
          `${moduleOwner(module.metatype)} was built importing the module ` +
          `"${moduleName(imported.metatype)}", which the seal never read.`
        );
      }
    }
  }
  return null;
}

function changedModule(kept: Sealed, module: BuiltModule): string | null {
  const owner = moduleOwner(module.metatype);
  if (module.isGlobal) {
    return (
      `${owner} was built global, which would export its providers into ` +
      "every module in the application."
    );
  }
  const provided = kept.provided.get(module.metatype);
  for (const token of module.providers.keys()) {
    // NestJS gives every module these three itself.
    if (
      token === module.metatype ||
      token === ModuleRef ||
      token === ApplicationConfig ||
      provided?.has(token) === true
    ) {
      continue;
    }
    return unreadProvider(owner, token);
  }
  // A guard or the like a class names is registered as that class; anything
  // else here is an application-wide provider of a request scope.
  for (const token of module.injectables.keys()) {
    if (typeof token !== "function") {
      return unreadProvider(owner, token);
    }
  }
  for (const [controller, instance] of module.controllers) {
    if (!kept.controllers.includes(controller)) {
      return (
        `${owner} was built with a controller the seal did not seal, which ` +
        "would be served outside the plugin's routes."
      );
    }
    const refusal = sealControllerInstance(kept, controller, instance);
    if (refusal !== null) {
      return refusal;
    }
  }
  for (const instances of [
    module.providers,
    module.controllers,
    module.injectables,
  ]) {
    for (const instance of instances.values()) {
      const reached = deniedDependency(instance);
      if (reached !== null) {
        return `${owner} was built with ${reached}, which a plugin may not hold.`;
      }
    }
  }
  return null;
}

/**
 * Checks that a sealed controller was built into an instance of the class the
 * seal read, and fixes the instance as it was checked, or explains why the
 * plugin is refused.
 *
 * The seal reads a controller's class, and NestJS serves the object it built
 * from it: the router reads a route's metadata from the instance's prototype
 * and calls the instance's own method of that name, and the guard is told the
 * class a request reached by the instance's `constructor`. Building it runs the
 * plugin's code - a constructor, a field's initialiser - which decides what the
 * instance holds. So a controller has to be built once, before this, and not
 * for each request; its instance has to have the prototype the seal read, which
 * names the controller as its constructor; and the instance may hold nothing of
 * its own under a name on that prototype's chain, which the router and the
 * guard would find first. What the chain holds is read again with the rest of
 * the seal's reads (`changedRead`).
 *
 * That holds when it is checked, and the plugin's code runs after it: a timer
 * or a promise it left behind before NestJS mounts the routes, its lifecycle
 * hooks once they are mounted. So the instance is then given its own
 * `constructor`, the controller, and its own method under each route the seal
 * sealed, the one the seal read, each read-only and not configurable. What an
 * object holds itself is found before anything on its prototype, so nothing
 * the plugin writes afterwards, to the instance or to its class's prototype,
 * changes the method mounted for a sealed route or the class the guard is told.
 * The instance then takes no new property and keeps its prototype, and that
 * prototype, the controller's own, is frozen, with each prototype further down
 * the chain that the plugin's entry defines (`pluginBases`). NestJS writes to
 * none of them once it has built the instance. The rest of the chain is left
 * as it is, because a class there can be one the whole process shares, such as
 * Node's `EventTarget`. The methods are kept with the controller, with what the
 * seal checked of each route (`fixedController`), and the guards serve and
 * authorize a plugin's controller by those (`checkedRoute`), wherever the
 * router mounts them.
 */
function sealControllerInstance(
  kept: Sealed,
  controller: unknown,
  built: BuiltInstance,
): string | null {
  const owner = `The controller "${moduleName(controller)}"`;
  // A controller that depends on anything built for each request is built for
  // each request itself, after this check, and those are the objects served.
  if (built.isTransient || !built.isDependencyTreeStatic()) {
    return (
      `${owner} is built for each request or each injection, after its ` +
      "instance could be checked."
    );
  }
  const read = kept.controllerClasses.get(controller);
  const { instance } = built;
  if (
    read === undefined ||
    types.isProxy(read.prototype) ||
    !isRecord(instance) ||
    types.isProxy(instance) ||
    Object.getPrototypeOf(instance) !== read.prototype ||
    Object.getOwnPropertyDescriptor(read.prototype, "constructor")?.value !==
      controller
  ) {
    return (
      `${owner} was built into something other than an instance of the ` +
      "class the seal read."
    );
  }
  const names = chainNames(read.prototype);
  const own = Object.getOwnPropertyNames(instance).find((name) =>
    names.has(name),
  );
  if (own !== undefined) {
    return (
      `${owner} was built holding its own \`${named(own)}\`, which NestJS ` +
      "would use in place of the one the seal read on its class."
    );
  }
  // The instance is no proxy, so defining runs no code; an instance made
  // fixed when it was built fails it.
  const pinned = [
    ...read.routes.map(({ name, handler }) => [name, handler] as const),
    ["constructor", controller] as const,
  ].every(([key, value]) =>
    Reflect.defineProperty(instance, key, {
      value,
      writable: false,
      enumerable: false,
      configurable: false,
    }),
  );
  if (
    !pinned ||
    !isRecord(controller) ||
    !Reflect.preventExtensions(instance) ||
    !frozen(read.prototype) ||
    !frozenBases(read)
  ) {
    return `${owner} could not be fixed to the routes and the class the seal read.`;
  }
  FIXED_CONTROLLERS.set(controller, {
    pluginId: kept.pluginId,
    routes: new Map(
      read.routes.map(({ handler, checked }) => [handler, checked]),
    ),
  });
  return null;
}

/**
 * Freezes an object the seal has read, or says it could not. Not a proxy, so
 * freezing it runs no code.
 */
function frozen(target: object): boolean {
  try {
    Object.freeze(target);
    return true;
  } catch {
    // A typed array with elements cannot be frozen.
    return false;
  }
}

/**
 * Freezes the prototypes further down a controller's chain that the seal found
 * the plugin's entry defines, or says it could not. Walked along the chain as
 * it is now, up to the first prototype that is not one of them: one put on the
 * chain after the seal read it is not known to be the plugin's, and the rest
 * of the chain is left with it.
 */
function frozenBases(read: SealedClass): boolean {
  // Neither the controller's prototype nor any of these is a proxy, so walking
  // the chain runs no code.
  for (
    let current = Reflect.getPrototypeOf(read.prototype);
    current !== null && read.bases.has(current);
    current = Reflect.getPrototypeOf(current)
  ) {
    if (!frozen(current)) {
      return false;
    }
  }
  return true;
}

/** `Function.prototype.toString`, as it was before any plugin was loaded. */
const sourceOf = Object.getOwnPropertyDescriptor(Function.prototype, "toString")
  ?.value as (this: object) => unknown;

/**
 * The prototypes further down a controller's chain that the plugin's entry
 * defines, from the controller's base up to the first one it does not.
 *
 * JavaScript does not say where a class was defined, so a class is taken to be
 * the plugin's when the source text of its entry holds the class's own. One
 * that a built-in, Node or a shared package defines is not there, and neither
 * is one from another of the plugin's files, so either is left as it is, with
 * the rest of the chain above it. So is a prototype that no class names as its
 * own. Leaving a prototype of the plugin's is the safe way to be wrong: what
 * the router mounts from it is still held to what the seal checked
 * (`checkedRoute`). Freezing one the process shares would break every object
 * built from it, and is wrong only for an entry that carries a copy of a
 * shared class's text and extends the shared class rather than its copy.
 *
 * Read without running the plugin's code.
 */
function pluginBases(prototype: object, source: string): Set<object> {
  const bases = new Set<object>();
  for (
    let current = Reflect.getPrototypeOf(prototype), depth = 1;
    current !== null && current !== Object.prototype;
    current = Reflect.getPrototypeOf(current), depth += 1
  ) {
    if (depth === MAX_PROTOTYPE_DEPTH) {
      throw prototypeChainTooLong();
    }
    if (types.isProxy(current)) {
      throw proxyOnChain();
    }
    const owner: unknown = Object.getOwnPropertyDescriptor(
      current,
      "constructor",
    )?.value;
    if (
      typeof owner !== "function" ||
      types.isProxy(owner) ||
      Object.getOwnPropertyDescriptor(owner, "prototype")?.value !== current ||
      !definedIn(owner, source)
    ) {
      break;
    }
    bases.add(current);
  }
  return bases;
}

/** Whether a function's own source text is in a plugin's source. */
function definedIn(target: object, source: string): boolean {
  const text = Reflect.apply(sourceOf, target, []);
  // A built-in's text, or a bound function's, is no source at all.
  return (
    typeof text === "string" &&
    !text.endsWith("[native code] }") &&
    source.includes(text)
  );
}

/**
 * Every name on a prototype chain, up to `Object.prototype`, where NestJS
 * stops looking for routes. Read without running the plugin's code.
 */
function chainNames(prototype: object): Set<string> {
  const names = new Set<string>();
  for (
    let current: object | null = prototype, depth = 0;
    current !== null && current !== Object.prototype;
    current = Reflect.getPrototypeOf(current), depth += 1
  ) {
    if (depth === MAX_PROTOTYPE_DEPTH) {
      throw prototypeChainTooLong();
    }
    if (types.isProxy(current)) {
      throw proxyOnChain();
    }
    for (const name of Object.getOwnPropertyNames(current)) {
      names.add(name);
    }
  }
  return names;
}

function moduleOwner(metatype: unknown): string {
  return `The module "${moduleName(metatype)}"`;
}

function moduleName(metatype: unknown): string {
  return typeof metatype === "function" ? nameOf(metatype) : "(unnamed)";
}

function unreadProvider(owner: string, token: unknown): string {
  const name =
    typeof token === "string"
      ? [...APPLICATION_WIDE_TOKENS].find(([wide]) =>
          // NestJS registers each under its own name and an id.
          token.startsWith(`${String(wide)} (`),
        )?.[1]
      : undefined;
  return name === undefined
    ? `${owner} was built with a provider the seal did not read.`
    : `${owner} was built with an application-wide ${name}, which would act ` +
        "on the application's own routes.";
}

/** The first denied service NestJS gave an instance, if it gave it one. */
function deniedDependency(instance: BuiltInstance): string | null {
  const tokens = [
    ...(instance.getCtorMetadata() ?? []).map((each) => each?.token),
    ...(instance.getPropertiesMetadata() ?? []).map(
      (each) => each.wrapper.token,
    ),
  ];
  for (const token of tokens) {
    const name = tokenNames(token).find((each) =>
      FORBIDDEN_INJECTIONS.has(each),
    );
    if (name !== undefined) {
      return name;
    }
  }
  return null;
}

function sealModuleInstance(module: BuiltModule): string | null {
  const { metatype, instance } = module;
  const owner = moduleOwner(metatype);
  if (!isRecord(instance)) {
    return `${owner} was not built into an object NestJS can read.`;
  }
  const configure = field(instance, "configure");
  if (configure === UNREADABLE) {
    return unreadableField(owner, "configure");
  }
  if (isPresent(configure)) {
    return registersMiddleware(owner);
  }
  // The instance is no proxy, which `field` has seen to, so defining runs no
  // code; an instance made fixed when it was built fails it.
  const pinned = Reflect.defineProperty(instance, "configure", {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return pinned
    ? null
    : `${owner} could not be fixed to registering no middleware.`;
}

function registersMiddleware(owner: string): string {
  return (
    `${owner} registers middleware, which would run on the application's ` +
    "own routes as well as the plugin's."
  );
}

interface WalkState {
  controllers: unknown[];
  /** Every module class in the graph, for `sealModuleInstances`. */
  modules: unknown[];
  /** The provider tokens read for each module class, for the same. */
  provided: Map<unknown, Set<unknown>>;
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

/** The fields of a dynamic module NestJS reads. */
const DYNAMIC_MODULE_FIELDS = [
  "module",
  "global",
  ...MODULE_LISTS,
  "exports",
] as const;

/**
 * What NestJS's reading of a dynamic module would run or be handed besides
 * the fields it reads, or null when there is nothing.
 *
 * NestJS takes a dynamic module apart with a spread, which runs every getter
 * the object holds of its own and enumerates, whichever key it is under. A
 * key the seal never reads, `exports` or one NestJS has no use for, could hold
 * the plugin's code there and have it run in the middle of the build. A
 * symbol's data is let through: NestJS writes its own id for the module under
 * one.
 */
function unspreadable(record: object): string | null {
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor?.enumerable !== true) {
      continue;
    }
    if (!("value" in descriptor)) {
      return "holds a field behind a getter, which NestJS would run";
    }
    if (
      typeof key === "string" &&
      !(DYNAMIC_MODULE_FIELDS as readonly string[]).includes(key)
    ) {
      return "holds a field a dynamic module does not have";
    }
  }
  return null;
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

  // NestJS takes anything with a `module` for a dynamic module, a class
  // included, and registers that `module` rather than the class. Its fields
  // are fixed before they are read, so a thunk the walk calls later cannot
  // give it other lists.
  if (
    typeof resolved === "object" &&
    !fixFields(resolved, DYNAMIC_MODULE_FIELDS)
  ) {
    return "A module in the graph could not be fixed to the lists it was read with.";
  }
  const declared = isRecord(resolved) ? field(resolved, "module") : undefined;
  if (declared === UNREADABLE) {
    return unreadableField("A module in the graph", "module");
  }
  const dynamic = isPresent(declared) ? (resolved as object) : null;
  const moduleClass = dynamic === null ? resolved : declared;

  if (typeof moduleClass !== "function") {
    return "A module in the graph is neither a class nor a dynamic module.";
  }
  if (types.isProxy(moduleClass)) {
    return proxiedClass("A module class in the graph");
  }
  if (!state.modules.includes(moduleClass)) {
    state.modules.push(moduleClass);
  }
  const moduleName = nameOf(moduleClass);
  const owner = `The module "${moduleName}"`;

  // A getter added after this is found when the module is read again
  // (`changedRead`). One added while NestJS builds the module is not, and can
  // change only what is checked once it is built (`sealModuleInstances`).
  if (dynamic !== null) {
    const spread = unspreadable(dynamic);
    if (spread !== null) {
      return `A dynamic module of "${moduleName}" ${spread}.`;
    }
    remember(dynamic, "spread", {
      key: "fields",
      value: null,
      again: () => unspreadable(dynamic),
    });
  }

  // Read from both the class's decorator and the dynamic object, because
  // NestJS merges the two and a check that read only one would be told half
  // the truth. Truthy rather than `true`, which is the test NestJS applies.
  const global = dynamic === null ? undefined : field(dynamic, "global");
  if (global === UNREADABLE) {
    return unreadableField(owner, "global");
  }
  if (
    isPresent(reflect(moduleClass, GLOBAL_MODULE_METADATA)) ||
    isPresent(global)
  ) {
    return (
      `${owner} is declared global, which would export its providers into ` +
      "every module in the application."
    );
  }

  // NestJS asks the module's instance, which reads through this prototype.
  // What the class's construction gives the instance is read once it is built
  // (`sealModuleInstances`).
  const modulePrototype = field(moduleClass, "prototype");
  const configure = isRecord(modulePrototype)
    ? field(modulePrototype, "configure")
    : modulePrototype;
  if (configure === UNREADABLE) {
    return unreadableField(owner, "configure");
  }
  if (typeof configure === "function") {
    return registersMiddleware(owner);
  }

  // NestJS registers every module class as a provider of its own module and
  // builds it from the same injector, so the class is checked as one.
  const reachedByModule = firstForbidden(classReaches(moduleClass));
  if (reachedByModule !== null) {
    state.outcome.refusedFor = "forbidden-injection";
    return (
      `The module "${moduleName}" reaches ` +
      `${reachedByModule}, which a plugin may not hold.`
    );
  }

  /*
   * NestJS spreads each of these lists, so a set of providers is registered
   * as surely as an array of them. The seal reads only what it can read whole,
   * where anything else would be read as empty and check nothing. Each is read
   * once, so what is checked is what was read; a list behind a getter reads as
   * `UNREADABLE` and is refused with the rest. Each is frozen as it is read,
   * before any thunk below runs, so what was read is what NestJS reads. A
   * dynamic module's imports are only closed to new entries here, and frozen
   * once the forward references in them are replaced (`resolveDynamicImports`).
   */
  const lists: Partial<Record<(typeof MODULE_LISTS)[number], unknown[]>> = {};
  let dynamicImports: unknown;
  let dynamicImportsRead: Array<[number, unknown]> = [];
  let dynamicImportsLength = 0;
  for (const key of MODULE_LISTS) {
    const read: unknown[] = [];
    const fromDynamic = dynamic === null ? undefined : field(dynamic, key);
    if (key === "imports") {
      dynamicImports = fromDynamic;
    }
    for (const [list, open] of [
      [reflect(moduleClass, key), false],
      [fromDynamic, key === "imports"],
    ] as const) {
      const entries = positioned(list, open);
      if (entries === UNREADABLE) {
        return notPlainList(owner, key);
      }
      if (open) {
        dynamicImportsRead = entries;
        dynamicImportsLength = Array.isArray(list) ? list.length : 0;
      }
      read.push(...entries.map(([, entry]) => entry));
    }
    lists[key] = read;
  }

  for (const provider of lists.providers ?? []) {
    if (types.isProxy(provider)) {
      return proxiedClass(`A provider in "${moduleName}"`);
    }
    // NestJS reads a declaration's token and what it is built from again, so
    // it keeps the fields it was checked with.
    if (isRecord(provider)) {
      fix(provider);
    }
    /*
     * NestJS reads guards, interceptors, filters and pipes from any provider
     * with a prototype, not only from a class. An object provider carrying one
     * would have them built without being a class this reads them from, and
     * no ordinary provider declaration has one.
     */
    if (
      typeof provider === "object" &&
      provider !== null &&
      isPresent(field(provider, "prototype"))
    ) {
      return (
        `A provider in "${moduleName}" is an object with a prototype, ` +
        "which NestJS would read enhancers from as if it were a class."
      );
    }
    if (declaresProvider(provider)) {
      return (
        `A provider in "${moduleName}" is a class with a static ` +
        "`provide`, which NestJS would register as the declaration it " +
        "describes rather than as the class."
      );
    }

    const token = providerToken(provider);
    if (token === UNREADABLE) {
      return unreadableField(`A provider in "${moduleName}"`, "provide");
    }
    const name = APPLICATION_WIDE_TOKENS.get(token);
    if (name !== undefined) {
      return (
        `The module "${moduleName}" registers an application-wide ` +
        `${name}, which would act on the application's own routes.`
      );
    }

    const reached = forbiddenInjection(provider);
    if (reached !== null) {
      state.outcome.refusedFor = "forbidden-injection";
      return (
        `A provider in "${moduleName}" reaches ` +
        `${reached}, which a plugin may not hold.`
      );
    }

    let provided = state.provided.get(moduleClass);
    if (provided === undefined) {
      provided = new Set();
      state.provided.set(moduleClass, provided);
    }
    provided.add(token);
  }

  for (const controller of lists.controllers ?? []) {
    if (types.isProxy(controller)) {
      return proxiedClass(`A controller in "${moduleName}"`);
    }
    const reached = firstForbidden(classReaches(controller));
    if (reached !== null) {
      state.outcome.refusedFor = "forbidden-injection";
      return (
        `A controller in "${moduleName}" reaches ` +
        `${reached}, which a plugin may not hold.`
      );
    }
    if (!state.controllers.includes(controller)) {
      state.controllers.push(controller);
    }
  }

  const unfixed = resolveDynamicImports(
    owner,
    dynamicImports,
    dynamicImportsRead,
    dynamicImportsLength,
  );
  if (unfixed !== null) {
    return unfixed;
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
 * ended up, which is not something the plugin's own source shows. Returns the
 * prototype it read the routes of as well, and each route it sealed with the
 * method it read for it, which the controller's instance is held to once it is
 * built, and what it checked of the route, which the guards hold requests to.
 */
function sealController(
  controller: unknown,
  prefix: string,
  options: SealOptions,
):
  | {
      ok: true;
      path: string;
      prototype: object;
      bases: Set<object>;
      routes: SealedRoute[];
    }
  | { ok: false; log: string } {
  if (typeof controller !== "function") {
    return {
      ok: false,
      log: "A controller in the module graph is not a class.",
    };
  }
  const controllerName = nameOf(controller);
  if (reflect(controller, CONTROLLER_WATERMARK) !== true) {
    return {
      ok: false,
      log: `"${controllerName}" is listed as a controller but is not decorated with @Controller.`,
    };
  }
  if (ownMetadata(controller, PLUGIN_ID_METADATA) !== undefined) {
    return {
      ok: false,
      log: `The controller "${controllerName}" appears in more than one plugin module.`,
    };
  }

  /*
   * Merged, not replaced: the guard reads the class's list and the handler's
   * together, so a route asking for more than the floor keeps what it asked
   * for and no route can ask for less. Read as a plain array and written back
   * as a fresh one, because asking a list of the plugin's whether it holds the
   * floor would let the list answer.
   */
  const existing = listed(reflect(controller, REQUIRED_CAPABILITIES));
  if (existing.includes(UNREADABLE)) {
    return {
      ok: false,
      log: notPlainList(`The controller "${controllerName}"`, "capabilities"),
    };
  }
  const floored = existing.includes(options.floor)
    ? existing
    : [...existing, options.floor];

  // A list of paths is read as a plain array, as every list the seal reads is.
  const declared = reflect(controller, PATH_METADATA);
  const paths = Array.isArray(declared) ? listed(declared) : [declared];
  if (paths.includes(UNREADABLE)) {
    return {
      ok: false,
      log: notPlainList(`The controller "${controllerName}"`, "path"),
    };
  }
  const rewritten: string[] = [];

  for (const path of paths) {
    const own = normalizeSegment(path);
    if (own === null) {
      return {
        ok: false,
        log:
          `The controller "${controllerName}" declares the path ` +
          `${pathText(path)}, which steps outside the plugin's own prefix.`,
      };
    }
    rewritten.push(own === "" ? prefix : `${prefix}/${own}`);
  }

  // Handler paths stay relative to the controller, so only their shape is
  // checked. Stripping @Public() has to happen here as well as on the class:
  // the guard reads the handler first and a method-level opt-out would win.
  // NestJS routes every method with a path, whether or not it names a request
  // method, and scans a prototype that is a function as it scans an object.
  const prototype = field(controller, "prototype");
  if (prototype === UNREADABLE) {
    return {
      ok: false,
      log: unreadableField(`The controller "${controllerName}"`, "prototype"),
    };
  }
  /*
   * The guard is told which class a request reached by the instance's
   * `constructor`, which the instance finds on this prototype, and reads the
   * capability floor from that class. A prototype naming another class, as an
   * ES5-style subclass's does, would have the guard read the floor from a class
   * the seal never wrote it onto. The instance NestJS builds is held to the
   * same once it is built (`sealControllerInstance`).
   */
  const declaredConstructor = isRecord(prototype)
    ? field(prototype, "constructor")
    : undefined;
  if (declaredConstructor === UNREADABLE) {
    return {
      ok: false,
      log: unreadableField(
        `The prototype of the controller "${controllerName}"`,
        "constructor",
      ),
    };
  }
  if (!isRecord(prototype) || declaredConstructor !== controller) {
    return {
      ok: false,
      log:
        `The controller "${controllerName}" has a prototype that does not ` +
        "name it as its constructor, so the guard would not read the " +
        "permissions written onto it.",
    };
  }
  const routes: SealedRoute[] = [];
  for (const { name, handler } of handlers(prototype)) {
    if (
      reflect(handler, PATH_METADATA) === undefined &&
      reflect(handler, METHOD_METADATA) === undefined
    ) {
      continue;
    }
    const route = `The route ${controllerName}.${named(name)}`;
    const methodPath = reflect(handler, PATH_METADATA);
    const methodPaths = Array.isArray(methodPath)
      ? listed(methodPath)
      : [methodPath];
    /*
     * The guard merges the route's list of capabilities into the class's
     * with the route list's own `concat`, so a list that brings its own
     * methods would decide what the route requires.
     */
    const declaredRequired = reflect(handler, REQUIRED_CAPABILITIES);
    const required = listed(declaredRequired);
    if (methodPaths.includes(UNREADABLE) || required.includes(UNREADABLE)) {
      return {
        ok: false,
        log: notPlainList(
          route,
          methodPaths.includes(UNREADABLE) ? "path" : "capabilities",
        ),
      };
    }
    for (const path of methodPaths) {
      if (path !== undefined && normalizeSegment(path) === null) {
        return {
          ok: false,
          log:
            `${route} declares the path ${pathText(path)}, which steps ` +
            "outside the plugin's own prefix.",
        };
      }
    }
    // Defined false rather than deleted: deleting removes only the class's
    // own metadata, and a plugin controller extending a base that declared
    // itself public would keep the inherited opt-out.
    rewrite(IS_PUBLIC_ROUTE, false, handler);
    // Written back as a list of its own, as the class's is, holding only the
    // entries the seal read: the guard walks every position up to a list's
    // length on each request, and a sparse list can claim billions.
    const asked = isPresent(declaredRequired) ? required : [];
    if (isPresent(declaredRequired)) {
      rewrite(REQUIRED_CAPABILITIES, required, handler);
    }
    const checked: CheckedRoute = {
      // NestJS mounts only a method with a path.
      paths:
        methodPath === undefined
          ? new Set()
          : mountedPaths(rewritten, methodPaths),
      methods: answeredMethods(reflect(handler, METHOD_METADATA)),
      // In the order the guard merges them: the route's, then the class's.
      capabilities: Object.freeze([...asked, ...floored] as Capability[]),
    };
    const writes = writesUnderDeviceRoute(checked, options.deviceRoutes ?? []);
    if (writes !== null) {
      return {
        ok: false,
        log:
          `${route} answers ${writes.method} on a path under the device route ` +
          `${pathText(writes.deviceRoute)}, which answers GET and HEAD only.`,
      };
    }
    routes.push({ name, handler, checked });
  }

  rewrite(
    PATH_METADATA,
    Array.isArray(declared) ? rewritten : rewritten[0],
    controller,
  );
  // A plugin route answers on the instance's own host, whatever the controller
  // asked for.
  rewrite(HOST_METADATA, undefined, controller);
  rewrite(IS_PUBLIC_ROUTE, false, controller);
  rewrite(REQUIRED_CAPABILITIES, floored, controller);
  rewrite(PLUGIN_ID_METADATA, options.pluginId, controller);

  return {
    ok: true,
    path: loggedPaths(rewritten),
    prototype,
    bases: pluginBases(prototype, options.source),
    routes,
  };
}

/** The request methods a device route answers. A device reads (ADR 0031). */
const DEVICE_ROUTE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * A method other than GET or HEAD that a route answers on a path that could be
 * a device route's, or null.
 *
 * Read from the paths the router will mount the route on, so a parameter
 * segment that could take the device route's place counts as reaching it:
 * `POST :id` on the plugin's mount would otherwise answer a write under
 * `screen` that only a device token can reach.
 */
function writesUnderDeviceRoute(
  checked: CheckedRoute,
  deviceRoutes: readonly string[],
): { method: string; deviceRoute: string } | null {
  for (const deviceRoute of deviceRoutes) {
    for (const path of checked.paths) {
      if (!patternReaches(path, deviceRoute)) {
        continue;
      }
      if (checked.methods === null) {
        return { method: "every method", deviceRoute };
      }
      for (const method of checked.methods) {
        if (!DEVICE_ROUTE_METHODS.has(method)) {
          return { method, deviceRoute };
        }
      }
    }
  }
  return null;
}

/** Composes a route's paths as the router composes them. */
const ROUTE_PATHS = new RoutePathFactory(new ApplicationConfig());

/**
 * Each path the router mounts a route on, spelled as the router spells it:
 * each of the controller's paths, as the seal rewrote them, joined with each of
 * the route's own. The application sets no global prefix and no versioning, so
 * neither is part of it.
 */
function mountedPaths(
  controllerPaths: readonly string[],
  methodPaths: readonly unknown[],
): Set<string> {
  const paths = new Set<string>();
  for (const ctrlPath of controllerPaths) {
    for (const methodPath of methodPaths) {
      for (const path of ROUTE_PATHS.create({
        ctrlPath,
        // NestJS mounts a path that is not a string on the controller's own.
        methodPath: typeof methodPath === "string" ? methodPath : undefined,
      })) {
        paths.add(path);
      }
    }
  }
  return paths;
}

/**
 * The request methods a route answers, by the method NestJS mounts it with, or
 * null for one mounted for every method. A route with no method NestJS can
 * mount it with answers none.
 */
function answeredMethods(method: unknown): ReadonlySet<string> | null {
  if (method === RequestMethod.ALL) {
    return null;
  }
  // The server answers a HEAD request on every GET route.
  if (method === RequestMethod.GET) {
    return new Set(["GET", "HEAD"]);
  }
  const name =
    typeof method === "number"
      ? (RequestMethod as Record<number, string | undefined>)[method]
      : undefined;
  return new Set(name === undefined ? [] : [name]);
}

/**
 * Writes metadata the seal fixes onto a plugin's class, and keeps the write as
 * the read expected of it from then on. A list is frozen first, because the
 * plugin can read it back and change it where it lies.
 */
function rewrite(key: string, value: unknown, target: object): void {
  Reflect.defineMetadata(
    key,
    Array.isArray(value) ? Object.freeze(value) : value,
    target,
  );
  expectWritten(target, metadataSlot(key, undefined), () =>
    reflect(target, key),
  );
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
 * to be called to find out what it holds is not one. A proxy on the chain is
 * refused, because listing its names and walking past it are its own traps.
 *
 * Kept as read, because a method the plugin adds afterwards is one the router
 * would mount without the seal having seen it.
 */
function handlers(prototype: object): Method[] {
  const found = methodsOf(prototype);
  const flat = (methods: Method[]): unknown[] =>
    methods.flatMap(({ name, handler }) => [name, handler]);
  remember(prototype, "methods", {
    key: "methods",
    value: flat(found),
    again: () => flat(methodsOf(prototype)),
    composed: true,
  });
  return found;
}

function methodsOf(prototype: object): Method[] {
  const found: Method[] = [];
  const seen = new Set<string>(["constructor"]);

  for (
    let current: object | null = prototype, depth = 0;
    current !== null && current !== Object.prototype;
    current = Reflect.getPrototypeOf(current), depth += 1
  ) {
    if (depth === MAX_PROTOTYPE_DEPTH) {
      throw prototypeChainTooLong();
    }
    if (types.isProxy(current)) {
      throw proxyOnChain();
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

/**
 * Unwraps a forwardRef, or explains why the entry cannot be checked.
 *
 * Read from a class as from an object, because NestJS asks both the same
 * questions: it awaits every module it registers, so anything with a `then` is
 * replaced by what that resolves to, and it calls the `forwardRef` of anything
 * that has one. It unwraps a second time when it compiles the module, so a
 * reference that resolves to another reference is refused rather than followed.
 * And where it registers a dynamic module's imports it asks for `module` before
 * `forwardRef`, so an entry with both is registered both ways and is refused.
 *
 * NestJS calls the thunk again wherever it meets the reference, so it is pinned
 * to what the seal resolved (`pinForwardReference`). Where NestJS would write
 * onto the reference, it is replaced by what it resolved to
 * (`resolveDynamicImports`).
 */
function resolveForwardReference(
  entry: unknown,
): { entry: unknown } | { refusal: string } {
  if (!isRecord(entry)) {
    return { entry };
  }
  const promised = promisedRefusal(entry);
  if (promised !== null) {
    return { refusal: promised };
  }
  const forwardRef = field(entry, "forwardRef");
  if (forwardRef === UNREADABLE) {
    return { refusal: unreadableField("A module in the graph", "forwardRef") };
  }
  if (!isPresent(forwardRef)) {
    return { entry };
  }
  if (readsAsDynamicModule(entry)) {
    return { refusal: forwardAndDynamic() };
  }
  const pinned = pinForwardReference(entry, forwardRef);
  if ("threw" in pinned) {
    // The thunk is the plugin's, so what it threw is the plugin's text and
    // stays out of the refusal, which is written to the log.
    return {
      refusal:
        "A forward reference in the module graph threw " +
        `${failureName(pinned.threw)} and could not be resolved.`,
    };
  }
  if ("unpinned" in pinned) {
    return { refusal: unpinnedReference() };
  }
  /*
   * The thunk ran on the reference after the reads above, and could have
   * changed what they found - given it a `then` or a `module`, or a prototype
   * that carries one. The reference is frozen, so nothing changes it again, and
   * read once more.
   */
  if (!Object.isFrozen(Object.freeze(entry))) {
    return { refusal: unpinnedReference() };
  }
  const promisedAfter = promisedRefusal(entry);
  if (promisedAfter !== null) {
    return { refusal: promisedAfter };
  }
  if (readsAsDynamicModule(entry)) {
    return { refusal: forwardAndDynamic() };
  }
  const { resolved } = pinned;
  if (isRecord(resolved)) {
    const promisedTarget = promisedRefusal(resolved);
    if (promisedTarget !== null) {
      return { refusal: promisedTarget };
    }
    if (isPresent(field(resolved, "forwardRef"))) {
      return {
        refusal:
          "A forward reference in the module graph resolves to another " +
          "forward reference.",
      };
    }
  }
  return { entry: resolved };
}

/**
 * Puts the module each forward reference in a dynamic module's imports
 * resolved to in the reference's place, or explains why the list could not
 * take it.
 *
 * NestJS registers a dynamic module's imports as they are listed, and keys a
 * forward reference there by the reference object, writing the key onto it. A
 * reference the seal followed is frozen (`resolveForwardReference`), so it
 * cannot take the key and the build fails. Everywhere else NestJS meets the
 * reference - when it scans the graph and when it links the import - it
 * follows it to its module, so listing the module itself builds what the
 * reference would have built, and builds it once.
 *
 * What is resolved here is what the walk read, and only a plain array is
 * written to. A list that refuses the write, frozen say, is refused itself.
 *
 * The walk could not freeze the list as it read it, as it does every other
 * list, since it is written to here; it only closed it to new entries. It is
 * frozen once written, and a list that no longer holds what was read, with
 * each reference replaced, is refused: a thunk the seal called in between
 * could have changed it. That includes its length, which closing the list to
 * new entries leaves writable: a longer list holds a hole NestJS would fail on,
 * so the length it had when read is compared too.
 */
function resolveDynamicImports(
  owner: string,
  imports: unknown,
  read: ReadonlyArray<[number, unknown]>,
  length: number,
): string | null {
  const resolved: unknown[] = [];
  for (const [index, entry] of read) {
    const reference = resolveForwardReference(entry);
    if ("refusal" in reference) {
      return reference.refusal;
    }
    if (
      reference.entry !== entry &&
      !Reflect.defineProperty(imports as object, index, {
        value: reference.entry,
      })
    ) {
      return (
        `${owner} lists its imports in a list that cannot take the module a ` +
        "forward reference in it resolved to."
      );
    }
    resolved.push(reference.entry);
  }
  const written = positioned(imports);
  if (
    written === UNREADABLE ||
    (Array.isArray(imports) ? imports.length : 0) !== length ||
    written.length !== read.length ||
    written.some(
      ([index, entry], at) =>
        index !== read[at]?.[0] || !Object.is(entry, resolved[at]),
    )
  ) {
    return (
      `${owner} changed its \`imports\` after the seal read them, so NestJS ` +
      "would not build what was checked."
    );
  }
  return null;
}

/** Why a module NestJS would await is refused, or null when it has no `then`. */
function promisedRefusal(entry: object): string | null {
  if (field(entry, "then") === UNREADABLE) {
    return unreadableField("A module in the graph", "then");
  }
  // Asked only once the chain is known to hold no proxy, so `in` runs no trap.
  if ("then" in entry) {
    return (
      "A module in the graph is imported as a promise, which cannot be " +
      "checked before the application is built."
    );
  }
  return null;
}

function forwardAndDynamic(): string {
  return (
    "A module in the graph is both a forward reference and a dynamic " +
    "module, which NestJS reads two ways."
  );
}

function unpinnedReference(): string {
  return (
    "A forward reference in the module graph could not be fixed to what it " +
    "resolved to."
  );
}

/** Pins the seal put in place of a plugin's thunks. */
const PINS = new WeakSet<object>();

/**
 * Calls a forward reference's thunk once and fixes the reference to the result.
 * It is called on the reference, as NestJS calls it.
 *
 * NestJS calls the thunk again each time it meets the reference: when it scans
 * the graph, when it compiles a module and when it resolves a dependency. The
 * thunk is the plugin's code, free to answer each call differently, so a check
 * of one answer would vouch for none of the others. The reference's
 * `forwardRef` is replaced with one that returns the value the seal checked,
 * read-only and not configurable, as a controller's path is rewritten. A
 * reference that refuses the replacement, frozen say, is refused itself.
 *
 * A pin is the seal's own and answers the same every time, so a reference
 * holding one is read through it rather than through a call of the plugin's
 * code. It is still fixed onto that reference: the plugin can hand one
 * reference's pin to another as a property it can replace again, and the pin
 * vouches only for where it is fixed.
 */
function pinForwardReference(
  record: object,
  thunk: unknown,
): { resolved: unknown } | { threw: unknown } | { unpinned: true } {
  let pin: () => unknown;
  if (typeof thunk === "function" && PINS.has(thunk)) {
    pin = thunk as () => unknown;
  } else {
    let resolved: unknown;
    try {
      // Called on the reference, as NestJS calls it, so a thunk that reads
      // `this` answers the seal what it would answer NestJS.
      resolved = Reflect.apply(thunk as () => unknown, record, []);
    } catch (cause) {
      return { threw: cause };
    }
    pin = (): unknown => resolved;
    PINS.add(pin);
  }
  // The record is no proxy, which `field` has seen to, so defining runs no
  // code; a thunk that made the property fixed meanwhile fails it. Defining a
  // reference's own pin again changes nothing and succeeds.
  const pinned = Reflect.defineProperty(record, "forwardRef", {
    value: pin,
    writable: false,
    enumerable:
      Object.getOwnPropertyDescriptor(record, "forwardRef")?.enumerable ?? true,
    configurable: false,
  });
  if (!pinned) {
    return { unpinned: true };
  }
  // Read back, so the pin is the read expected of the reference from now on.
  expectWritten(record, fieldSlot("forwardRef"), () =>
    field(record, "forwardRef"),
  );
  return { resolved: pin() };
}

/** What NestJS takes for a dynamic module: anything with a `module`. */
function readsAsDynamicModule(value: unknown): boolean {
  return isRecord(value) && isPresent(field(value, "module"));
}

/**
 * A class NestJS would register as a custom provider rather than as itself.
 *
 * NestJS decides by `provide` alone and never asks whether the value is a
 * class, so a class with a static `provide` is built from its static
 * `useClass`, `useFactory` and `inject`, and may name an application-wide
 * token. No decorated class needs one, or keeps one behind a getter.
 */
function declaresProvider(value: unknown): boolean {
  if (typeof value !== "function") {
    return false;
  }
  const provide = field(value, "provide");
  return provide !== undefined && provide !== null;
}

function isDynamicModule(value: unknown): value is DynamicModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof field(value, "module") === "function"
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
      return "a forward reference that could not be resolved and fixed";
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
 *
 * A proxy on the chain is refused, because it chooses which bases it shows.
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
      if (types.isProxy(current)) {
        throw proxyOnChain();
      }
      // The name is what the denylist is matched against, so a getter that
      // could answer the match one name and the log another is refused.
      const name = field(current, "name");
      if (name === UNREADABLE) {
        throw new SealRefusal(unreadableField("A class in the graph", "name"));
      }
      if (typeof name === "string") {
        names.push(name);
      }
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
 * and the bound is what stops one that returns itself. Each link is pinned to
 * what it resolved to, because NestJS calls the thunk again.
 */
function resolveInjectionToken(token: unknown): unknown {
  let held = token;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof held !== "object" || held === null) {
      return held;
    }
    const thunk = field(held, "forwardRef");
    if (thunk === UNREADABLE) {
      return UNRESOLVED;
    }
    if (typeof thunk !== "function") {
      return held;
    }
    // A thunk that threw is the plugin's text, and stays out of the refusal,
    // which is written to the log.
    const pinned = pinForwardReference(held, thunk);
    if (!("resolved" in pinned)) {
      return UNRESOLVED;
    }
    held = pinned.resolved;
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

  const provide = field(provider, "provide");
  const useClass = field(provider, "useClass");
  const useExisting = field(provider, "useExisting");
  const inject = field(provider, "inject");
  if ([provide, useClass, useExisting, inject].includes(UNREADABLE)) {
    return [UNREADABLE];
  }
  const reached: unknown[] = [];

  /*
   * NestJS reads the enhancers of a bare class provider only, but checking
   * these two as well costs nothing and does not lean on that detail.
   */
  if (typeof provide === "function") {
    reached.push(provide, ...classReaches(provide));
  }
  if (typeof useClass === "function") {
    // What is actually constructed when the token is not the class itself.
    reached.push(useClass, ...classReaches(useClass));
  }
  if (useExisting !== undefined) {
    // An alias resolves to what it names, so naming one is holding it.
    reached.push(useExisting);
  }
  // A factory's arguments, resolved exactly as a constructor's are. NestJS
  // reads them with `Array.from`, which takes any iterable.
  reached.push(...listed(inject).flatMap(injectedTokens));
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
    if (!isRecord(entry)) {
      // NestJS destructures the entry, which fails the boot for these.
      continue;
    }
    // NestJS destructures the entry once per build, so a getter could give it
    // a parameter the seal was never shown, and so could a write afterwards.
    fix(entry);
    const index = field(entry, "index");
    const param = field(entry, "param");
    if (index === UNREADABLE || param === UNREADABLE) {
      return [UNREADABLE];
    }
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
    ...listed(reflect(token, PROPERTY_DEPS_METADATA)).map((entry) => {
      if (entry === UNREADABLE || !isRecord(entry)) {
        return entry === UNREADABLE ? entry : undefined;
      }
      fix(entry);
      return field(entry, "type");
    }),
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
  // NestJS scans a prototype that is a function as it scans an object.
  const prototype = field(target, "prototype");
  if (prototype === UNREADABLE) {
    return [UNREADABLE];
  }
  if (isRecord(prototype)) {
    for (const { name, handler } of handlers(prototype)) {
      for (const key of ENHANCER_METADATA) {
        enhancers.push(...listed(reflect(handler, key)));
      }
      const parameters = reflect(target, ROUTE_ARGS_METADATA, name);
      if (!isPresent(parameters)) {
        continue;
      }
      /*
       * NestJS takes the parameters with `Object.values` and flattens each
       * one's `pipes` one level, so a single class written there rather than
       * in a list is built all the same. Decorators write each as a record.
       */
      if (isRecord(parameters)) {
        fix(parameters);
      }
      const records = isRecord(parameters) ? ownValues(parameters) : UNREADABLE;
      if (records === UNREADABLE) {
        enhancers.push(UNREADABLE);
        continue;
      }
      for (const parameter of records) {
        if (isRecord(parameter)) {
          fix(parameter);
        }
        const pipes = isRecord(parameter)
          ? field(parameter, "pipes")
          : UNREADABLE;
        enhancers.push(...(Array.isArray(pipes) ? listed(pipes) : [pipes]));
      }
    }
  }
  return [
    ...constructorReaches(target),
    ...enhancers.flatMap((enhancer) =>
      // An enhancer with a static `provide` is built as the declaration it
      // describes, which is not what its constructor says.
      enhancer === UNREADABLE || declaresProvider(enhancer)
        ? [UNREADABLE]
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
 *
 * Frozen as it is read. NestJS reads the same array later, and the plugin's
 * code - a thunk the seal calls next, or a timer - could otherwise add to it
 * what the seal never checked. Neither NestJS nor a decorator writes into a
 * list once it is made; a decorator applied afterwards writes a new one. A list
 * the seal writes to itself is read `open`: closed to new entries, and frozen
 * once written (`resolveDynamicImports`).
 */
function positioned(
  value: unknown,
  open = false,
): Array<[number, unknown]> | typeof UNREADABLE {
  if (!isPresent(value)) {
    return [];
  }
  if (!isPlainArray(value)) {
    return UNREADABLE;
  }
  if (open) {
    Object.preventExtensions(value);
  } else {
    Object.freeze(value);
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

/**
 * A value NestJS reads fields from when it holds a dependency record.
 *
 * NestJS destructures the record, and a function carries its own fields as
 * well as an object does, so one is read here rather than passed over.
 */
function isRecord(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
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
  if (typeof entry !== "object" || entry === null) {
    return [entry];
  }
  const token = field(entry, "token");
  if (token === UNREADABLE) {
    return [UNREADABLE];
  }
  // Asked only once the chain is known to hold no proxy, so `in` runs no trap.
  if (!("token" in entry)) {
    return [entry];
  }
  // A wrapper is the plugin's declaration rather than a token, and is kept.
  fix(entry);
  return [token, entry];
}

function providerToken(provider: unknown): unknown {
  if (typeof provider === "function") {
    return provider;
  }
  if (typeof provider === "object" && provider !== null) {
    return field(provider, "provide");
  }
  return null;
}

/**
 * A field of a record the plugin supplied, as a data property holds it, or
 * `UNREADABLE` where reading it would run the plugin's code.
 *
 * NestJS reads each of these again, often more than once, when it builds the
 * module. A getter or a proxy answers every read afresh, so what the seal was
 * told need not be what NestJS is told; a data property gives both the same
 * answer. Looked up along the prototype chain as a read is, so an inherited
 * getter, or a proxy further up, is caught as well.
 *
 * Kept as read, for `rereadSealedModule`.
 */
function field(record: object, key: string): unknown {
  const value = readField(record, key);
  remember(record, fieldSlot(key), {
    key,
    value,
    again: () => readField(record, key),
  });
  return value;
}

function readField(record: object, key: string): unknown {
  for (
    let current: object | null = record, depth = 0;
    current !== null;
    current = Object.getPrototypeOf(current) as object | null, depth += 1
  ) {
    if (depth === MAX_PROTOTYPE_DEPTH) {
      throw prototypeChainTooLong();
    }
    if (types.isProxy(current)) {
      return UNREADABLE;
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      return "value" in descriptor ? descriptor.value : UNREADABLE;
    }
  }
  return undefined;
}

/**
 * What `Object.values` gives NestJS for a record, or `UNREADABLE` where
 * listing it or reading one of its values would run the plugin's code.
 */
function ownValues(record: object): unknown[] | typeof UNREADABLE {
  if (types.isProxy(record)) {
    return UNREADABLE;
  }
  const values: unknown[] = [];
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!("value" in descriptor)) {
      return UNREADABLE;
    }
    values.push(descriptor.value);
  }
  return values;
}

/**
 * Metadata as NestJS reads it, once the chain it is looked up along is checked.
 *
 * `Reflect.getMetadata` looks a key up the target's chain of parents, and a
 * proxy there, or a getter where reflect-metadata guesses a function's
 * heritage, would choose what each lookup finds. The chain is walked first,
 * the way reflect-metadata walks it, and refused if any link would run code.
 *
 * Kept as read, for `rereadSealedModule`: metadata is held apart from the
 * class, where freezing the class would not keep it.
 */
function reflect(target: object, key: string, property?: string): unknown {
  const value = readMetadata(target, key, property);
  remember(target, metadataSlot(key, property), {
    key,
    on: property,
    value,
    again: () => readMetadata(target, key, property),
  });
  return value;
}

function readMetadata(
  target: object,
  key: string,
  property: string | undefined,
): unknown {
  for (
    let current: object | null = target, depth = 0;
    current !== null;
    current = metadataParent(current), depth += 1
  ) {
    if (depth === MAX_PROTOTYPE_DEPTH) {
      throw prototypeChainTooLong();
    }
  }
  return Reflect.getMetadata(key, target, property as string) as unknown;
}

/**
 * The next object reflect-metadata looks a key up on (its
 * `OrdinaryGetPrototypeOf`), found without running the plugin's code.
 *
 * Usually the prototype. A function whose prototype is `Function.prototype`
 * may still have been given a superclass the ES5 way, so reflect-metadata reads
 * its heritage from `prototype` and the `constructor` above it instead.
 */
function metadataParent(target: object): object | null {
  if (types.isProxy(target)) {
    throw proxyOnChain();
  }
  const parent = Object.getPrototypeOf(target) as object | null;
  if (
    typeof target !== "function" ||
    target === Function.prototype ||
    parent !== Function.prototype
  ) {
    return parent;
  }
  const prototype = field(target, "prototype");
  if (prototype === UNREADABLE || types.isProxy(prototype)) {
    throw proxyOnChain();
  }
  const above: unknown = prototype && Object.getPrototypeOf(prototype);
  if (above === null || above === undefined || above === Object.prototype) {
    return parent;
  }
  const constructor = field(Object(above) as object, "constructor");
  if (constructor === UNREADABLE) {
    throw proxyOnChain();
  }
  return typeof constructor === "function" && constructor !== target
    ? constructor
    : parent;
}

function ownMetadata(target: object, key: string): unknown {
  return Reflect.getOwnMetadata(key, target) as unknown;
}

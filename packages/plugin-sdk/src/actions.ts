import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * What the platform can be asked to do, declared once and dispatched through
 * one place: an action (atgard).
 *
 * An action is a name, an input schema, the single capability it needs, what it
 * does to the records, which categories of personal data it can touch, and which
 * surfaces it may be offered on. The registry checks the calling person's
 * capability on every call rather than trusting the caller, so registering an
 * action is never a permission of its own - it is a way of reaching something
 * the caller could already do.
 *
 * A core feature registers its own. A plugin registers the ones its manifest
 * declared and the board consented to, and they disappear with the plugin.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */

export const ACTION_EFFECTS = ["read", "write", "delete"] as const;
export type ActionEffect = (typeof ACTION_EFFECTS)[number];

/**
 * Where an action may be offered.
 *
 * "ui" means in-process only: the platform's own screens and a plugin's own
 * route. The other two are the ones a board switches on deliberately.
 */
export const ACTION_SURFACES = ["ui", "mcp", "ai"] as const;
export type ActionSurface = (typeof ACTION_SURFACES)[number];

/**
 * What an action can touch.
 *
 * The first thirteen are PERSONAL_DATA_CATEGORIES from @openbrf/shared, in
 * order, which this package deliberately does not depend on; the API side
 * asserts the prefix equality, because it is the only place that can import
 * both. "protected" is this list's own and marks an action that can return a
 * field of a person carrying protected personal data (skyddade
 * personuppgifter): it is the value the registry refuses to expose to a
 * connected app or to the AI package at all.
 */
export const ACTION_PERSONAL_DATA = [
  "name",
  "apartment",
  "residency",
  "email",
  "phone",
  "postalAddress",
  "personalIdentityNumber",
  "account",
  "financial",
  "health",
  "photograph",
  "freeText",
  "auditTrail",
  "protected",
] as const;
export type ActionPersonalData = (typeof ACTION_PERSONAL_DATA)[number];

/**
 * What a public action name may look like.
 *
 * The intersection of three separate limits: what an MCP tools/list entry
 * allows, what a model API allows (no dots), and what stays readable in a
 * directory review (64 characters).
 */
export const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/** What a refusal means for a caller that is a model rather than a person. */
export interface ActionErrorSpec {
  /** The machine-readable reason the handler raises. */
  readonly reason: string;
  /** Whether trying again could ever work, and after what. */
  readonly retry: "never" | "after-edit" | "after-backoff";
  /** The sentence a person is shown, as an i18n key. */
  readonly messageKey: string;
}

/**
 * The request a plugin's own route received.
 *
 * Opaque on purpose: the host reads a symbol on it that only the host writes,
 * so a plugin passes the request it was handed straight through and cannot
 * construct one. That is what stops a plugin naming a person it was not given.
 */
export type ActionRequest = object;

/** The lowercase channel vocabulary. The registry maps it to the audit channel. */
export const ACTION_CHANNELS = [
  "web",
  "mcp",
  "ai",
  "system",
  "plugin",
] as const;
export type ActionChannel = (typeof ACTION_CHANNELS)[number];

/**
 * Who is acting.
 *
 * The person, and the capabilities the registry re-derived for this call. No
 * email, no name, no roles: a handler that needs to decide what an audience may
 * see reads the capability list, and a handler that does not need it is not
 * given a person's details to leak.
 */
export interface ActionPrincipal {
  readonly personId: string;
  readonly capabilities: readonly string[];
}

/** The connected app that acted, when one did. Both hosts, never the token. */
export interface ActionClient {
  readonly clientId: string;
  readonly clientHost: string | null;
}

/** What a handler is told about the call. Built by the host, never by a caller. */
export interface ActionContext {
  readonly principal: ActionPrincipal;
  readonly channel: ActionChannel;
  readonly client?: ActionClient;
  readonly requestId: string;
  readonly now: Date;
}

export interface ActionDefinition<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly group: string;
  readonly groupTitleKey: string;
  /** Exactly one core capability, by name. */
  readonly capability: string;
  readonly effect: ActionEffect;
  readonly idempotent: boolean;
  /**
   * True when the act adds and overwrites nothing a person wrote.
   *
   * It is what separates a create from an update, and the annotation mapping
   * reads it: MCP's destructiveHint defaults to true, so a non-read action has
   * to say for itself that it destroys nothing.
   */
  readonly additive: boolean;
  readonly needsConfirmation: boolean;
  /** True when the handler reaches a system outside this instance. */
  readonly openWorld: boolean;
  /** Never empty by convention: an action that touches none says []. */
  readonly personalData: readonly ActionPersonalData[];
  /** Opt-in allowlist. An empty array means the action is offered nowhere. */
  readonly surfaces: readonly ActionSurface[];
  /** Every domain refusal the handler can raise, for the caller to act on. */
  readonly errors: readonly ActionErrorSpec[];
  readonly deprecatedAliases?: readonly string[];
  /** Every object in it, at every depth, must refuse unknown keys. */
  readonly input: StandardSchemaV1<unknown, Input>;
  readonly output: StandardSchemaV1<unknown, Output>;
  readonly handler: (input: Input, context: ActionContext) => Promise<Output>;
}

/**
 * What a plugin hands the host: the id its manifest declared, and the rest.
 *
 * The capability, the effect, the personal-data categories and the surfaces are
 * manifest data and are not repeated here. The loader's rule is that nothing
 * which can refuse a plugin may run after the code that executes it, and the
 * install consent screen renders from the catalog before anything is
 * downloaded - so what the board consents to cannot come from the bundle.
 */
export interface PluginActionRegistration {
  readonly id: string;
  readonly definition: Omit<
    ActionDefinition,
    "capability" | "effect" | "personalData" | "surfaces"
  >;
}

/** Narrows what a plugin's route offers the request it is serving. */
export interface PluginActionFilter {
  readonly surface?: ActionSurface;
  readonly group?: string;
}

/** One action as a caller sees it, with its text already in the right language. */
export interface ActionSummary {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly group: string;
  readonly groupTitle: string;
  /**
   * The key behind `groupTitle`, alongside the two above.
   *
   * Both forms travel for the reason `titleKey` does: the resolved string is
   * for a caller with no translations of its own - a connected app, a model -
   * while a screen in this product translates the key itself. The interface's
   * language and the language a request happens to declare are not the same
   * thing, so a screen rendering the resolved string can show one heading in
   * the browser's language above a page in the association's.
   */
  readonly groupTitleKey: string;
  readonly capability: string;
  readonly effect: ActionEffect;
  readonly idempotent: boolean;
  readonly additive: boolean;
  readonly needsConfirmation: boolean;
  readonly openWorld: boolean;
  readonly personalData: readonly ActionPersonalData[];
  readonly surfaces: readonly ActionSurface[];
  readonly errors: readonly ActionErrorSpec[];
}

export interface PluginActions {
  /**
   * Registers an action the manifest declared.
   *
   * Callable from the module factory onwards: a call made that early is
   * buffered until the application is built, because the host object is not
   * bound yet.
   *
   * It does not throw for a registration the host will refuse. An id the
   * manifest never declared, or a schema that cannot be published, is found
   * when the buffer is flushed - long after this call returned - and reaches
   * the board as an `action-refused` finding rather than as an error the
   * factory could have caught. A plugin that wants to know sooner validates
   * its own manifest in its own build.
   */
  register: (registration: PluginActionRegistration) => void;

  /** What this plugin's route may offer the request it is serving. */
  list: (
    request: ActionRequest,
    filter?: PluginActionFilter,
  ) => Promise<ActionSummary[]>;

  /**
   * Dispatch. The person, the channel and the connected app all come from the
   * request the host authenticated, never from an argument.
   */
  invoke: <Output>(
    request: ActionRequest,
    name: string,
    input: unknown,
  ) => Promise<Output>;
}

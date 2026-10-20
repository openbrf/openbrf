import type { PluginAbortSignal } from "./abort-signal.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Plugins that extend plugins (ADR 0030).
 *
 * An extension point (utökningspunkt) is a named slot a plugin declares in its
 * manifest and offers to other plugins; that plugin is the point's host plugin.
 * An addon (utökning) is a plugin that extends another at one of its points,
 * and what it registers there is a contribution (bidrag): a title and a
 * handler. Each is a plugin in every other respect, installed, consented to and
 * switched on by itself, and neither receives the other's permissions.
 *
 * The host carries every call between them. It validates the input against the
 * host plugin's schema before the call and the output after it, copies both as
 * JSON values so that nothing but data crosses, and answers for what the addon
 * did in the result rather than by throwing: a screen that loses one source
 * should go on with the others.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */

/**
 * What an extension point id may look like, in the manifest and at the host.
 *
 * Lowercase letters, digits and single hyphens, two to thirty-two characters:
 * the shape a plugin id has, shorter, because it is shown beside one.
 */
export const EXTENSION_POINT_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** How many points a plugin may declare, and how many an addon may extend. */
export const MAX_EXTENSION_POINTS = 8;

/** How long a contribution may take when its point names no time of its own. */
export const EXTENSION_TIMEOUT_MS = 5_000;

/** The longest a point may give a contribution. */
export const EXTENSION_MAX_TIMEOUT_MS = 15_000;

/**
 * The longest answer a contribution may give, in characters of its JSON text.
 * A longer one is `output-invalid`, refused before it is parsed or validated.
 */
export const EXTENSION_MAX_OUTPUT_LENGTH = 1_048_576;

/**
 * Why `invoke` answered without a value.
 *
 * Everything an addon can do wrong, and the one state the host plugin cannot
 * see from its own side, so a host plugin can tell a broken addon from one that
 * is switched off without either being thrown at it.
 */
export const EXTENSION_RESULT_REASONS = [
  /**
   * The addon is not installed, not loaded, switched off, or has registered no
   * contribution at this point.
   */
  "not-serving",
  /**
   * The handler did not answer in time. Its signal was aborted.
   *
   * The time bounds only how long the host waits for the handler's promise.
   * Work the handler does synchronously, and a `toJSON` or getter in its
   * answer, runs on the host's one thread with no limit, as any plugin code
   * does: a handler that loops stalls the instance.
   */
  "timed-out",
  /** The handler threw. What it threw is in the server log, never here. */
  "failed",
  /**
   * The answer does not meet the point's output schema, has no JSON form, or
   * is longer than EXTENSION_MAX_OUTPUT_LENGTH as JSON.
   */
  "output-invalid",
] as const;

export type ExtensionResultReason = (typeof EXTENSION_RESULT_REASONS)[number];

/** What the host plugin hands `define` for one point its manifest declares. */
export interface ExtensionPointDefinition<Input = unknown, Output = unknown> {
  /**
   * What the host plugin sends a contribution. A strict object at every depth,
   * built with the host's zod, with no record, catchall, `unknown` or `any`
   * anywhere inside it.
   */
  readonly input: StandardSchemaV1<unknown, Input>;
  /**
   * What a contribution must answer. A strict object at every depth, built with
   * the host's zod, with no record, catchall, `unknown` or `any` anywhere inside
   * it: a key the schema does not name is a key an addon could hand over
   * something nobody consented to in.
   */
  readonly output: StandardSchemaV1<unknown, Output>;
  /**
   * How long a contribution may take, in milliseconds.
   * EXTENSION_TIMEOUT_MS by default, at most EXTENSION_MAX_TIMEOUT_MS.
   */
  readonly timeoutMs?: number;
}

/** What the host tells a contribution about the call it is answering. */
export interface ExtensionContext {
  /** The plugin whose point is being answered. */
  readonly hostPlugin: string;
  readonly point: string;
  /** The point's major version, which is the one the addon named. */
  readonly version: number;
  /** For the logs, so a call can be followed from one plugin to the other. */
  readonly requestId: string;
  readonly now: Date;
  /** Aborted when the call times out or the host plugin gives up on it. */
  readonly signal: PluginAbortSignal;
}

/** What an addon hands `contribute` for one point its manifest extends. */
export interface ExtensionContributionDefinition<
  Input = unknown,
  Output = unknown,
> {
  /**
   * A bare key in the addon's own namespace, as an action's is. The host
   * qualifies it as `plugin-<addon>:<key>`.
   */
  readonly titleKey: string;
  readonly descriptionKey?: string;
  /**
   * Answers one call.
   *
   * Runs with the addon's own host object, under the permissions the board
   * consented to for the addon, and with no person behind it: an extension
   * point is a call from one plugin to another, not somebody's request. It
   * must accept input fields it does not know, because a host plugin may add
   * an optional field to a point without raising its version.
   */
  readonly handler: (
    input: Input,
    context: ExtensionContext,
  ) => Promise<Output>;
}

/** One contribution that is serving at a point, as its host plugin sees it. */
export interface ExtensionContributionSummary {
  /** The addon's plugin id, which `invoke` takes. */
  readonly addon: string;
  /** Qualified into the addon's namespace, `plugin-<addon>:<key>`. */
  readonly titleKey: string;
  readonly descriptionKey: string | null;
}

/** What `invoke` answers: a value, or why there is none. */
export type ExtensionResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly reason: ExtensionResultReason };

/** The plugin and the point an addon contributes to. */
export interface ExtensionTarget {
  readonly plugin: string;
  readonly point: string;
}

/**
 * Extension points, as a plugin sees them.
 *
 * A host plugin uses `define`, `list` and `invoke`; an addon uses
 * `contribute`. `define` and `contribute` are declarations, callable from the
 * module factory onwards and buffered until the application exists, as
 * `host.actions.register` is. A definition or contribution the host cannot
 * accept - a point or target the manifest does not declare, a schema that is
 * not a strict object built with the host's zod, a second one for the same
 * point - is found when the buffer is flushed and stops the plugin with
 * `extension-refused`, rather than throwing here.
 *
 * `list` and `invoke` keep the ordinary gate and work from `onModuleInit`
 * onwards.
 */
export interface PluginExtensions {
  /** Host plugin: the schemas of a point its manifest declares. */
  define<Input, Output>(
    point: string,
    definition: ExtensionPointDefinition<Input, Output>,
  ): void;

  /**
   * Host plugin: the contributions to one of its points that are serving now,
   * in addon id order.
   *
   * Throws for a point the manifest does not declare or the plugin has not
   * defined.
   */
  list(point: string): Promise<readonly ExtensionContributionSummary[]>;

  /**
   * Host plugin: calls one addon's contribution.
   *
   * Throws for a mistake of the host plugin's own: a point its manifest does
   * not declare or it has not defined, or an input its own schema refuses. An
   * aborted `signal` rejects with the signal's reason. Everything the addon
   * does is answered in the result.
   */
  invoke<Output>(
    point: string,
    addon: string,
    input: unknown,
    options?: { signal?: PluginAbortSignal },
  ): Promise<ExtensionResult<Output>>;

  /** Addon: the handler for a point its manifest extends. Once per point. */
  contribute<Input, Output>(
    target: ExtensionTarget,
    contribution: ExtensionContributionDefinition<Input, Output>,
  ): void;
}

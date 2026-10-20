import type { ActionRetry } from "./actions.ts";

/**
 * Why the registry refused a call, in a form a caller can act on.
 *
 * A caller here is often a model rather than a person, which changes what a
 * refusal has to carry. A person reads a sentence and decides what to do; a
 * model needs to know whether trying again could ever work, and what to change
 * if it could. So every refusal has a code, a status, and a published rule for
 * how a connector should render it.
 *
 * The vocabulary lives here rather than in the API because a plugin dispatching
 * through `host.actions.invoke` has no other way to read it: the catalogue
 * endpoint serves the same table over HTTP, and a plugin in the same process
 * has no route to that. The API imports it back, so there is one list.
 */

export const ACTION_ERROR_REASONS = [
  "unknown-action",
  "forbidden-capability",
  "forbidden-surface",
  "insufficient-scope",
  "not-serving",
  "read-only",
  "confirmation-required",
  "output-invalid",
  "rate-limited",
  "internal",
] as const;

export type ActionErrorReason = (typeof ACTION_ERROR_REASONS)[number];

/**
 * How a connector should tell its caller about a refusal.
 *
 * A protocol error means the call never happened; a tool result means it
 * happened and was refused, and only the second is something to tell the
 * person about.
 */
export type ActionRefusalTransport = "protocol" | "tool-result";

/**
 * How a connector should render each refusal, published as data.
 *
 * Served on the catalogue endpoint as well, so that two connectors - one
 * reading it over HTTP, one in process - cannot disagree about whether a 403
 * is worth retrying. Keyed by the registry's reasons and by the two refusals
 * that are not the registry's own: a body the action's input schema refuses,
 * and a refusal raised by the service behind the action.
 */
export const ACTION_ERROR_MCP: Readonly<
  Record<
    ActionErrorReason | "invalid-body" | "domain",
    {
      readonly transport: ActionRefusalTransport;
      readonly retry: ActionRetry;
    }
  >
> = {
  "unknown-action": { transport: "protocol", retry: "never" },
  "invalid-body": { transport: "tool-result", retry: "after-edit" },
  "forbidden-capability": { transport: "tool-result", retry: "never" },
  "forbidden-surface": { transport: "tool-result", retry: "never" },
  "insufficient-scope": { transport: "tool-result", retry: "never" },
  "not-serving": { transport: "tool-result", retry: "never" },
  "read-only": { transport: "tool-result", retry: "after-backoff" },
  "confirmation-required": { transport: "tool-result", retry: "never" },
  "output-invalid": { transport: "protocol", retry: "never" },
  "rate-limited": { transport: "tool-result", retry: "after-backoff" },
  internal: { transport: "protocol", retry: "after-backoff" },
  domain: { transport: "tool-result", retry: "never" },
};

/**
 * Which of the three ways a call was refused.
 *
 * "registry" is the registry's own refusal, and `reason` is then one of
 * ACTION_ERROR_REASONS. "invalid-body" is an input the action's schema
 * refused, and `reason` is "invalid-body". "domain" is the service behind the
 * action refusing on the merits, and `reason` is one the action declared in
 * its `errors`.
 */
export type ActionRefusalKind = "registry" | "invalid-body" | "domain";

/**
 * What `host.actions.invoke` rejects with when the call was refused.
 *
 * One shape for all three kinds, so that a connector renders a refusal from
 * the fields it carries rather than by recognising the host's classes, which a
 * plugin cannot import. Recognise one with `isActionRefusal`, not with
 * `instanceof`: the host builds it, and a plugin's bundled copy of this
 * package is not the host's.
 *
 * A plugin route that rethrows one answers its caller with the same status,
 * body and headers the registry would have.
 */
export interface ActionRefusal extends Error {
  readonly name: "ActionRefusal";
  readonly kind: ActionRefusalKind;
  readonly reason: string;
  /** The HTTP status the refusal answers with. */
  readonly status: number;
  readonly transport: ActionRefusalTransport;
  /**
   * From ACTION_ERROR_MCP for the registry's refusals and an invalid body. For
   * a domain refusal, the verdict the action declared for that reason in its
   * `errors`, or "never" for a reason it did not declare.
   */
  readonly retry: ActionRetry;
  /**
   * The particulars the refusal publishes, keyed by the field they travel in.
   *
   * `scopes` on an insufficient-scope refusal names the scope the call needed.
   * `issues` on an invalid body lists `{ path, message }` for each failing
   * field, and never the submitted value.
   */
  details(): Record<string, readonly unknown[]>;
  /**
   * The bearer challenge to answer a connected app with, as the value of a
   * `WWW-Authenticate` header (RFC 6750, ADR 0009).
   *
   * Set on an insufficient-scope refusal, where it names every scope the
   * instance issues so the client can ask for what it is missing in one round
   * trip. Absent wherever no challenge would help.
   */
  readonly challenge?: string;
}

const KINDS: readonly unknown[] = [
  "registry",
  "invalid-body",
  "domain",
] satisfies ActionRefusalKind[];
const TRANSPORTS: readonly unknown[] = [
  "protocol",
  "tool-result",
] satisfies ActionRefusalTransport[];
const RETRIES: readonly unknown[] = [
  "never",
  "after-edit",
  "after-backoff",
] satisfies ActionRetry[];
const REGISTRY_REASONS: readonly unknown[] = ACTION_ERROR_REASONS;

/**
 * Whether a value `host.actions.invoke` rejected with is a refusal.
 *
 * Structural rather than `instanceof`, for the reason on ActionRefusal. False
 * means the call failed rather than being refused - the host could not be
 * reached, or something broke - and a connector answers that as an internal
 * error without inspecting it.
 */
export function isActionRefusal(value: unknown): value is ActionRefusal {
  if (!(value instanceof Error) || value.name !== "ActionRefusal") {
    return false;
  }
  const refusal = value as Error &
    Partial<Record<keyof ActionRefusal, unknown>>;
  if (
    typeof refusal.reason !== "string" ||
    typeof refusal.status !== "number" ||
    typeof refusal.details !== "function" ||
    !KINDS.includes(refusal.kind) ||
    !TRANSPORTS.includes(refusal.transport) ||
    !RETRIES.includes(refusal.retry) ||
    (refusal.challenge !== undefined && typeof refusal.challenge !== "string")
  ) {
    return false;
  }
  switch (refusal.kind) {
    case "registry":
      return REGISTRY_REASONS.includes(refusal.reason);
    case "invalid-body":
      return refusal.reason === "invalid-body";
    default:
      return true;
  }
}

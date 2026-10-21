import { HttpStatus } from "@nestjs/common";
import { type ActionErrorReason, isActionRefusal } from "@openbrf/plugin-sdk";

import { DomainError } from "../http/domain-error";

/**
 * Why the registry refused a call, in a form a caller can act on.
 *
 * A caller here is often a model rather than a person, which changes what a
 * refusal has to carry. A person reads a sentence and decides what to do; a
 * model needs to know whether trying again could ever work, and what to change
 * if it could. So every refusal has a code, a status, and a published rule for
 * how a connector should render it - and the connector reads that rule from the
 * catalogue rather than re-deriving it from the status.
 *
 * The reasons and the rule are part of the plugin contract and live in
 * @openbrf/plugin-sdk, so that a plugin dispatching in process reads the same
 * list a connector reads over HTTP. The status each reason answers with is
 * this class's.
 */

const STATUS: Record<ActionErrorReason, number> = {
  "unknown-action": HttpStatus.NOT_FOUND,
  "forbidden-capability": HttpStatus.FORBIDDEN,
  "forbidden-surface": HttpStatus.FORBIDDEN,
  "insufficient-scope": HttpStatus.FORBIDDEN,
  "not-serving": HttpStatus.NOT_FOUND,
  "read-only": HttpStatus.CONFLICT,
  "confirmation-required": HttpStatus.CONFLICT,
  "output-invalid": HttpStatus.INTERNAL_SERVER_ERROR,
  "rate-limited": HttpStatus.TOO_MANY_REQUESTS,
  internal: HttpStatus.INTERNAL_SERVER_ERROR,
};

export class ActionError extends DomainError {
  readonly status: number;

  constructor(
    readonly reason: ActionErrorReason,
    message: string,
    private readonly particulars?: Record<string, readonly unknown[]>,
    /**
     * The bearer challenge, for a refusal a connected app can act on.
     *
     * Set only where the caller presented a token and the refusal is about
     * the token rather than about the person: a client reading it can ask for
     * the scopes it is missing, which is the remedy. A refusal about what the
     * person may do carries none, because no challenge would help.
     */
    private readonly challenge?: string,
  ) {
    super(message);
    this.status = STATUS[reason];
  }

  override details(): Record<string, readonly unknown[]> {
    return this.particulars ?? {};
  }

  override headers(): Record<string, string> {
    return this.challenge === undefined
      ? {}
      : { "www-authenticate": this.challenge };
  }
}

/**
 * Whether a handler threw a refusal of its own: a `DomainError`, or anything
 * shaped like one, which is how a plugin's handler refuses without importing
 * the host's class. The registry passes such a refusal through untouched.
 */
export function isDomainError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "reason" in cause &&
    "status" in cause
  );
}

/**
 * Whether a failure out of `invoke()` is a refusal, as against a failure.
 *
 * A refusal is an answer: a check refused the call, or the action's own
 * service refused it before it wrote or rolled its write back, so the records
 * are as they were. `internal` and `output-invalid` are not answers. The first
 * is a handler that broke, possibly after its transaction committed; the
 * second comes only after the handler returned, so its write stands. A caller
 * that has to know whether something was written - the pending-change queue
 * deciding whether a confirmed change may wait again - reads it here.
 *
 * Either may reach the caller wrapped, so `dispatchFailure` reads through the
 * wrapping rather than this testing the class.
 */
export function isRefusal(cause: unknown): boolean {
  return dispatchFailure(cause) === null && isDomainError(cause);
}

/**
 * The registry failure a failed `invoke()` ended in, `internal` or
 * `output-invalid`, or null when it ended in neither.
 *
 * Read through what wraps it. A plugin's action that invokes another through
 * `host.actions.invoke` receives the inner call's failure as the published
 * refusal, kind `registry`, and may rethrow that, or a refusal of its own
 * whose `cause` is it; the registry passes either through as a domain refusal.
 * Whatever the wrapping, the inner action may have written, so the outer call
 * is no answer either.
 */
export function dispatchFailure(
  cause: unknown,
): "internal" | "output-invalid" | null {
  const seen = new Set<unknown>();
  let link = cause;
  // `seen` stops a cause chain that loops back on itself.
  while (typeof link === "object" && link !== null && !seen.has(link)) {
    seen.add(link);
    const failed =
      link instanceof ActionError
        ? link.reason
        : isActionRefusal(link) && link.kind === "registry"
          ? link.reason
          : null;
    if (failed === "internal" || failed === "output-invalid") {
      return failed;
    }
    link = (link as { cause?: unknown }).cause;
  }
  return null;
}

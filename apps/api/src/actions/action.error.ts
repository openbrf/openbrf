import { HttpStatus } from "@nestjs/common";
import type { ActionErrorReason } from "@openbrf/plugin-sdk";

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

import { HttpStatus } from "@nestjs/common";

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
  ) {
    super(message);
    this.status = STATUS[reason];
  }

  override details(): Record<string, readonly unknown[]> {
    return this.particulars ?? {};
  }
}

/**
 * How a connector should render each refusal, published as data.
 *
 * Served on the catalogue endpoint so the paid connector does not re-derive it,
 * and so two connectors cannot disagree about whether a 403 is worth retrying.
 * The distinction that matters to a model is protocol error against tool
 * result: a protocol error means the call never happened, while a tool result
 * means it happened and was refused, and only the second is something to tell
 * the person about.
 */
export const ACTION_ERROR_MCP: Record<
  ActionErrorReason | "invalid-body" | "domain",
  { readonly transport: "protocol" | "tool-result"; readonly retry: string }
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

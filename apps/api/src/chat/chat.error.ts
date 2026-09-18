import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/** Where in a message a refused value sits. */
export interface ChatTextLocation {
  /** The only free-text field a message has. */
  part: "body";
  /** Where in the body the refused value starts. */
  offset: number;
}

export type ChatReason =
  "chat-not-found" | "personal-identity-number" | "too-many-messages";

/**
 * A refusal from the chat.
 *
 * `chat-not-found` is deliberately vaguer than what happened, on the precedent
 * `news-comment.error.ts` sets and for the same reason. It answers a room that
 * does not exist and a room this person is not in, without distinguishing them.
 * Telling a caller that a room they cannot read exists would let anybody
 * holding `chat:participate` walk the identifier space and learn what rooms the
 * association has - and once groups exist, a group is invisible to somebody who
 * is not in it, which only holds if the two answers are one answer.
 *
 * The refusal for a personal identity number names positions and never the
 * value: the thing the scan caught is exactly the thing that must not travel
 * back in a response body, into a log, or onto a screen somebody else is
 * looking at.
 */
export class ChatError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: ChatReason,
    private readonly found: readonly ChatTextLocation[] = [],
  ) {
    super(message);
    this.status =
      reason === "too-many-messages"
        ? HttpStatus.TOO_MANY_REQUESTS
        : reason === "personal-identity-number"
          ? // Understood and refused on its merits: this message may not be
            // written as it stands, and its author is told where to change it.
            HttpStatus.UNPROCESSABLE_ENTITY
          : HttpStatus.NOT_FOUND;
  }

  /**
   * Where the refusal is, in one shape for every reason.
   *
   * One key rather than one per rule, so the screen has one thing to render.
   * Positions and a field name only: what was found is exactly what must not
   * travel back.
   */
  override details(): Record<string, readonly unknown[]> {
    return { locations: this.found };
  }
}

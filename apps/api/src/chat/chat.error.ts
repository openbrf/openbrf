import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/** Where in a piece of written text a refused value sits. */
export interface ChatTextLocation {
  /**
   * Which field it was in.
   *
   * A message has one. A report carries a note beside the message it is about,
   * and that note is written by a resident like everything else here, so it is
   * scanned on the same rule and the refusal has to be able to say which of the
   * two the reader is looking at.
   */
  part: "body" | "note";
  /** Where in that text the refused value starts. */
  offset: number;
}

export type ChatReason =
  | "chat-not-found"
  | "message-not-found"
  | "report-not-found"
  | "report-resolved"
  | "not-a-resident"
  | "not-reportable"
  | "too-many-groups"
  | "group-full"
  | "already-reported"
  | "personal-identity-number"
  | "too-many-messages";

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
 * `message-not-found` is vague in exactly the same way and for the same reason:
 * it answers a message that does not exist and one in a room this person is not
 * in, so a message identifier cannot be used to find out what is being said in
 * rooms somebody is not in.
 *
 * The rest say what happened, because none of them tells the caller anything
 * they did not already know. `not-a-resident` is the association telling
 * somebody a group is for the people who live here; `not-reportable` is the
 * board chat having no strike-through, which is a published rule; and
 * `already-reported` and `report-resolved` are about acts the caller made or
 * the board has already answered. `too-many-groups` and `group-full` are the
 * two bounds a list has to have to stay a list.
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
        : reason === "chat-not-found" ||
            reason === "message-not-found" ||
            reason === "report-not-found"
          ? HttpStatus.NOT_FOUND
          : /*
             * Understood and refused on its merits: what was asked for is a
             * thing this application does not do, and the caller is told which.
             * Not a 403, which is the guard's answer about a capability - these
             * callers hold the capability and are being told about the act.
             */
            HttpStatus.UNPROCESSABLE_ENTITY;
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

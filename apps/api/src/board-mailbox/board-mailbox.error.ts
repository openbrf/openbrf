import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A refusal from the board mailbox.
 *
 * `thread-not-found` is deliberately the answer to a thread that is not there
 * and to one this instance will not show, the way the issues module answers a
 * type the caller may not report under. There is only one capability here and
 * every holder may read every thread, so the two cases coincide today; stating
 * them as one answer is what keeps that true if a narrower read is ever added.
 *
 * `mailbox-not-configured` is its own reason rather than a not-found, because it
 * is the one refusal a board can act on: it means the settings are incomplete,
 * and the screen says so and names where to finish them.
 */
export class BoardMailboxError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "thread-not-found"
      | "mailbox-not-configured"
      | "mailbox-unreachable"
      | "mailbox-sign-in-refused"
      | "thread-closed"
      | "empty-reply",
  ) {
    super(message);
    this.status =
      reason === "mailbox-not-configured"
        ? HttpStatus.CONFLICT
        : reason === "mailbox-unreachable" ||
            reason === "mailbox-sign-in-refused"
          ? HttpStatus.BAD_GATEWAY
          : reason === "thread-closed"
            ? HttpStatus.CONFLICT
            : reason === "empty-reply"
              ? HttpStatus.BAD_REQUEST
              : HttpStatus.NOT_FOUND;
  }
}

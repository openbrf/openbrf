import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A refusal from the contact module.
 *
 * `not-found` is reachable without anybody doing anything wrong: the board's
 * inbox is a list read a moment ago, and a message can be removed between the
 * read and the decision. Answering that with the database's own failure would
 * surface a server error for something the board can simply be told about, so
 * it is a domain refusal like every other in this codebase.
 *
 * `unknown-cursor` is a place in the inbox this service did not hand out. Its
 * own reason rather than `not-found`, because nothing was removed: the reader
 * sent a value that never named a page, and reading from the start is the
 * answer.
 */
export type ContactReason = "not-found" | "unknown-cursor";

export class ContactError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: ContactReason,
  ) {
    super(message);
    this.status =
      reason === "unknown-cursor"
        ? HttpStatus.BAD_REQUEST
        : HttpStatus.NOT_FOUND;
  }
}

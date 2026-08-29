import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A refusal from the contact module.
 *
 * One reason so far, and it is reachable without anybody doing anything wrong:
 * the board's inbox is a list read a moment ago, and a message can be removed
 * between the read and the decision. Answering that with the database's own
 * failure would surface a server error for something the board can simply be
 * told about, so it is a domain refusal like every other in this codebase.
 */
export class ContactError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;

  constructor(
    message: string,
    readonly reason: "not-found",
  ) {
    super(message);
  }
}

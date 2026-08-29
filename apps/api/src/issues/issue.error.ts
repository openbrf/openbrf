import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A refusal from the issues module.
 *
 * Two of the reasons deserve a note, because they are deliberately vaguer than
 * what actually happened. A type the caller may not report under, and one that
 * does not exist, both answer `type-not-found`; so do an apartment that is not
 * in the register and one the caller does not live in. The alternative would
 * let a resident enumerate the board's internal categories, or the building's
 * apartments, one identifier at a time - and the media layer already answers a
 * file it will not serve exactly as a file that is not there, for the same
 * reason.
 */
export class IssueError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "type-not-found"
      | "type-in-use"
      | "issue-not-found"
      | "apartment-not-found"
      | "public-reporting-disabled"
      | "too-many-photos",
  ) {
    super(message);
    this.status =
      reason === "type-in-use"
        ? HttpStatus.CONFLICT
        : reason === "too-many-photos"
          ? HttpStatus.CONFLICT
          : reason === "public-reporting-disabled"
            ? HttpStatus.FORBIDDEN
            : HttpStatus.NOT_FOUND;
  }
}

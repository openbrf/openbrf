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
 *
 * `post-not-found` is vague in the feed's way: a report made from a post that
 * does not exist and one in an audience the reporter is not in get one answer,
 * so the form cannot be used to find out what is said in a group (ADR 0012).
 * `post-not-reportable` is a post the reporter can read and did not write
 * without a board seat, or one the purge has erased, and
 * `post-already-reported` one a report was already made from; neither tells
 * the reporter anything the post in front of them does not.
 *
 * The status reasons are the board's and the handlers'. `status-not-found` is a
 * status that is not one of the issue's own type's, or one switched off, for
 * the reason a type answers `type-not-found`. `waiting-reason-required` and
 * `outcome-required` are a move into the waiting or the done meaning without
 * what that meaning carries (ADR 0054), and `status-detail-not-applicable` a
 * reason or an outcome sent with a status of another meaning, which would
 * otherwise be dropped without the caller learning that it was.
 * `default-status-required` is an attempt to switch off or demote the one
 * status of a meaning an issue goes to when none is named, and
 * `too-many-statuses` a type already carrying as many as it may.
 */
export type IssueReason =
  | "type-not-found"
  | "type-in-use"
  | "issue-not-found"
  | "apartment-not-found"
  | "public-reporting-disabled"
  | "too-many-photos"
  | "post-not-found"
  | "post-not-reportable"
  | "post-already-reported"
  | "status-not-found"
  | "waiting-reason-required"
  | "outcome-required"
  | "status-detail-not-applicable"
  | "default-status-required"
  | "too-many-statuses";

export class IssueError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: IssueReason,
  ) {
    super(message);
    this.status =
      reason === "type-in-use" ||
      reason === "too-many-photos" ||
      reason === "post-already-reported" ||
      reason === "default-status-required" ||
      reason === "too-many-statuses"
        ? HttpStatus.CONFLICT
        : reason === "public-reporting-disabled"
          ? HttpStatus.FORBIDDEN
          : reason === "post-not-reportable" ||
              reason === "waiting-reason-required" ||
              reason === "outcome-required" ||
              reason === "status-detail-not-applicable"
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.NOT_FOUND;
  }
}

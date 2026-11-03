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
 *
 * The handling reasons. `assignee-not-a-handler` is somebody who does not
 * handle the issue now, a person the list never offered or one who stopped
 * handling since it was read; a person who does not exist gets the same
 * answer, so the route names nobody. `target-date-invalid` is a date the
 * calendar does not have. `resident-not-found` is a residency named on an
 * issue a handler opens that is not held today - ended, not yet begun, or
 * none at all - answered alike for the reason an apartment is.
 *
 * The conversation's reasons. `issue-closed` is a reporter writing on an issue
 * that is done and that a reply no longer reopens: it closed more than the
 * reopening window ago, or was merged into another (ADR 0054). It is also a
 * known fault published on an issue that is done. `no-reporter` is a handler writing to the reporter of an
 * issue nobody can read the answer on: an internal issue, a report from the
 * website's form, whose reporter has no account to read a thread in, and one
 * whose reporter was purged.
 * `personal-identity-number` is text the board writes back, a message, a note
 * or a saved reply, carrying a personal identity number, refused with where it
 * sits and never the value. `too-many-attachments` and `too-many-saved-replies`
 * are the bounds in `ISSUE_CONVERSATION_LIMITS`, and `saved-reply-not-found` a
 * saved reply that is not there.
 *
 * The lifecycle's reasons (decisions 8 and 22). `merge-into-itself` is an
 * issue merged into itself; `merge-into-duplicate` one merged into an issue
 * that is itself a duplicate, which would make a chain its reporter follows
 * through somebody else's report; and `merge-has-duplicates` one that others
 * were already merged into, which is merged the other way instead.
 * `known-fault-board-only` is a known fault on an issue the board keeps to
 * itself, which never reaches the house. `follow-up-of-open-issue` is a new
 * report filed as the follow-up of one's own issue that is still open, which
 * takes a reply instead.
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
  | "too-many-statuses"
  | "assignee-not-a-handler"
  | "target-date-invalid"
  | "resident-not-found"
  | "issue-closed"
  | "no-reporter"
  | "personal-identity-number"
  | "too-many-attachments"
  | "saved-reply-not-found"
  | "too-many-saved-replies"
  | "merge-into-itself"
  | "merge-into-duplicate"
  | "merge-has-duplicates"
  | "known-fault-board-only"
  | "follow-up-of-open-issue";

/**
 * Where in a message, a note or a saved reply a refused value sits: a part and
 * an offset, never the value.
 */
export interface IssueTextLocation {
  part: "body" | "title";
  offset: number;
}

export class IssueError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: IssueReason,
    private readonly locations: readonly IssueTextLocation[] = [],
  ) {
    super(message);
    this.status =
      reason === "type-in-use" ||
      reason === "too-many-photos" ||
      reason === "too-many-attachments" ||
      reason === "too-many-saved-replies" ||
      reason === "issue-closed" ||
      reason === "no-reporter" ||
      reason === "post-already-reported" ||
      reason === "default-status-required" ||
      reason === "too-many-statuses" ||
      reason === "merge-into-duplicate" ||
      reason === "merge-has-duplicates" ||
      reason === "known-fault-board-only"
        ? HttpStatus.CONFLICT
        : reason === "public-reporting-disabled"
          ? HttpStatus.FORBIDDEN
          : reason === "post-not-reportable" ||
              reason === "waiting-reason-required" ||
              reason === "outcome-required" ||
              reason === "status-detail-not-applicable" ||
              reason === "assignee-not-a-handler" ||
              reason === "target-date-invalid" ||
              reason === "personal-identity-number" ||
              reason === "merge-into-itself" ||
              reason === "follow-up-of-open-issue"
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.NOT_FOUND;
  }

  /**
   * Where a refused personal identity number sits, and nothing more: a part
   * and an offset, which are positions rather than content. The number itself
   * would put it in a response body, and from there into whatever logs it.
   */
  override details(): Record<string, readonly unknown[]> {
    return { locations: this.locations };
  }
}

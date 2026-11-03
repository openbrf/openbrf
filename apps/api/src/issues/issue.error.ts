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
 * The work order reasons. `contractor-not-found` is a contractor not on the
 * list, or switched off, and `contractor-without-email` one the list holds no
 * address for, so a work order to them has nowhere to go.
 * `contractor-incomplete` is a name or a trade that is nothing once the
 * invisible characters are taken out, and `work-order-empty` a work order
 * that says nothing on the same reading.
 * `work-order-ring-fenced` is an issue whose type nothing about may reach a
 * contractor (ADR 0055): stated rather than answered as not found, because the
 * handler asking already reads the issue. `work-order-identity-number` is a work order whose
 * text carries a personal identity number, which has no business leaving the
 * instance in a contractor's mail.
 * `work-order-preview-stale` is a sending whose preview no longer matches
 * what would be sent - the contractor's name or address changed, the text
 * differs, or the preview is too old - so the handler previews again before
 * anything leaves. `work-order-duplicate` is the same text to the same
 * contractor on the same issue a moment after the first, and
 * `work-order-budget-spent` a handler who has sent as many work orders as one
 * person may in an hour.
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
  | "contractor-not-found"
  | "contractor-without-email"
  | "contractor-incomplete"
  | "work-order-empty"
  | "work-order-ring-fenced"
  | "work-order-identity-number"
  | "work-order-preview-stale"
  | "work-order-duplicate"
  | "work-order-budget-spent";

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
      reason === "too-many-statuses" ||
      reason === "work-order-preview-stale" ||
      reason === "work-order-duplicate"
        ? HttpStatus.CONFLICT
        : reason === "work-order-budget-spent"
          ? HttpStatus.TOO_MANY_REQUESTS
          : reason === "public-reporting-disabled"
            ? HttpStatus.FORBIDDEN
            : reason === "post-not-reportable" ||
                reason === "waiting-reason-required" ||
                reason === "outcome-required" ||
                reason === "status-detail-not-applicable" ||
                reason === "assignee-not-a-handler" ||
                reason === "target-date-invalid" ||
                reason === "contractor-without-email" ||
                reason === "contractor-incomplete" ||
                reason === "work-order-empty" ||
                reason === "work-order-ring-fenced" ||
                reason === "work-order-identity-number"
              ? HttpStatus.UNPROCESSABLE_ENTITY
              : HttpStatus.NOT_FOUND;
  }
}

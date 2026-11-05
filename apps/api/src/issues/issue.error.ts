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
 *
 * `issue-closed` is also a handler writing a work order on an issue that is
 * done, which is reopened first.
 *
 * The conversation's reasons. `issue-closed` is a reporter writing on an issue
 * that is done and that a reply no longer reopens: it closed more than the
 * reopening window ago, or was merged into another (ADR 0054). It is also a
 * known fault published on an issue that is done. `no-reporter` is a handler writing to the reporter of an
 * issue nobody can read the answer on: an internal issue, a report from the
 * website's form whose reporter has no live private link (none mailed,
 * withdrawn or ended), and one whose reporter was purged. `no-reporter-link`
 * is a handler withdrawing the private link of a reporter who was never
 * mailed one (ADR 0055).
 * `personal-identity-number` is text the board writes back, a message, a note
 * or a saved reply, carrying a personal identity number, refused with where it
 * sits and never the value. `too-many-attachments` and `too-many-saved-replies`
 * are the bounds in `ISSUE_CONVERSATION_LIMITS`, and `saved-reply-not-found` a
 * saved reply that is not there.
 *
 * The ring-fence's reasons (decision 32). `ring-fence-in-use` is lifting the
 * ring-fence of a type issues have been reported under, which would hand them
 * to whoever the ring-fence keeps out. `ring-fenced-board-only` is opening a
 * ring-fenced type to every handler, and `ring-fenced-public` offering one on
 * the website's form, or ring-fencing a type the form offers: its reporter is
 * reached by mail alone, and nothing about a ring-fenced issue is mailed.
 * `ring-fenced-post` is reporting from a post under a ring-fenced type, which
 * would tie the report to something the house reads.
 *
 * The damage case's reasons (decision 28). `damage-case-incomplete` is an
 * insurer or a claim number that is nothing once the invisible characters are
 * taken out, and `damage-date-invalid` a day of the damage that is not a day,
 * or one that has not come yet in the association's calendar.
 * `damage-case-changed` is a change made from a mark another handler has
 * changed or taken off since, which would write over theirs unseen: the claim
 * number and the insurer are what a claim is made on.
 *
 * The lifecycle's reasons (decisions 8 and 22). `merge-into-itself` is an
 * issue merged into itself; `merge-into-duplicate` one merged into an issue
 * that is itself a duplicate, which would make a chain its reporter follows
 * through somebody else's report; and `merge-has-duplicates` one that others
 * were already merged into, which is merged the other way instead.
 * `merge-already-duplicate` is a duplicate merged into a different issue than
 * the one it follows, which would move its reporter between reports unseen;
 * it is reopened first.
 * `merge-into-closed` is an issue merged into one that is done, which would
 * leave its reporter following a report nobody is working on.
 * `merge-limit` is an issue merged into one that already has as many
 * duplicates as `ISSUE_LINK_LIMITS` allows.
 * `known-fault-board-only` is a known fault on an issue the board keeps to
 * itself, which never reaches the house. `follow-up-of-open-issue` is a new
 * report filed as the follow-up of one's own issue that is still open, which
 * takes a reply instead.
 * `merge-ring-fenced` is an issue merged into one on the other side of the
 * ring-fence, which would let a reporter follow, or be told of, a report the
 * ring-fence keeps from them.
 *
 * The Swedish-fit reasons (decisions 29 to 31). `place-not-found` is a place
 * that is not on the list or is switched off, answered alike. `place-name-taken`
 * is a name the list has under any capitalisation, `place-name-apartment` a
 * name that is an apartment, which the list never holds, `place-in-use` a
 * removal of a place an issue names and `too-many-places` the bound in
 * `ISSUE_FIT_LIMITS`. `place-with-apartment` is a place on an issue about an
 * apartment: the list is of what is not in a home, and an issue counted under
 * both would be counted as a fault in a common area. `entry-needs-apartment` is an entry permission on an
 * issue that is not about an apartment, `entry-not-resident` a reporter's yes
 * from someone who no longer holds a residency in that apartment,
 * `entry-until-past` an expiry before
 * today, and `door-code` an entry note that reads like a door code, refused
 * with where it starts and never the value. `finding-needs-target-date` and
 * `finding-target-date-too-late` hold a finding to a real target date and a lift to
 * its one month; `finding-protocol-not-found` is a protocol that is not one of
 * the issue's own handler files, and `date-invalid` a date the calendar does
 * not have.
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
  | "work-order-budget-spent"
  | "issue-closed"
  | "no-reporter"
  | "personal-identity-number"
  | "too-many-attachments"
  | "saved-reply-not-found"
  | "too-many-saved-replies"
  | "merge-into-itself"
  | "merge-into-duplicate"
  | "merge-has-duplicates"
  | "merge-already-duplicate"
  | "merge-into-closed"
  | "merge-limit"
  | "merge-ring-fenced"
  | "known-fault-board-only"
  | "follow-up-of-open-issue"
  | "place-not-found"
  | "place-name-taken"
  | "place-name-apartment"
  | "place-in-use"
  | "too-many-places"
  | "place-with-apartment"
  | "entry-needs-apartment"
  | "entry-not-resident"
  | "entry-until-past"
  | "door-code"
  | "finding-needs-target-date"
  | "finding-target-date-too-late"
  | "finding-protocol-not-found"
  | "date-invalid"
  | "no-reporter-link"
  | "redaction-target-not-found"
  | "legal-hold"
  | "ring-fence-in-use"
  | "ring-fenced-board-only"
  | "ring-fenced-public"
  | "ring-fenced-post"
  | "damage-case-incomplete"
  | "damage-date-invalid"
  | "damage-case-changed";

/**
 * Where in a message, a note or a saved reply a refused value sits: a part and
 * an offset, never the value.
 */
export interface IssueTextLocation {
  part: "body" | "title" | "entryNote";
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
      reason === "no-reporter-link" ||
      reason === "post-already-reported" ||
      reason === "default-status-required" ||
      reason === "too-many-statuses" ||
      reason === "merge-into-duplicate" ||
      reason === "merge-has-duplicates" ||
      reason === "merge-already-duplicate" ||
      reason === "merge-into-closed" ||
      reason === "merge-limit" ||
      reason === "merge-ring-fenced" ||
      reason === "known-fault-board-only" ||
      reason === "place-name-taken" ||
      reason === "place-in-use" ||
      reason === "too-many-places" ||
      reason === "place-with-apartment" ||
      reason === "entry-needs-apartment" ||
      reason === "entry-not-resident" ||
      reason === "work-order-preview-stale" ||
      reason === "work-order-duplicate" ||
      reason === "legal-hold" ||
      reason === "ring-fence-in-use" ||
      reason === "damage-case-changed"
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
                reason === "personal-identity-number" ||
                reason === "merge-into-itself" ||
                reason === "follow-up-of-open-issue" ||
                reason === "place-name-apartment" ||
                reason === "entry-until-past" ||
                reason === "date-invalid" ||
                reason === "door-code" ||
                reason === "finding-needs-target-date" ||
                reason === "finding-target-date-too-late" ||
                reason === "contractor-without-email" ||
                reason === "contractor-incomplete" ||
                reason === "work-order-empty" ||
                reason === "work-order-ring-fenced" ||
                reason === "work-order-identity-number" ||
                reason === "ring-fenced-board-only" ||
                reason === "ring-fenced-public" ||
                reason === "ring-fenced-post" ||
                reason === "damage-case-incomplete" ||
                reason === "damage-date-invalid"
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

/**
 * A common-area place named on an issue about an apartment, by a request the
 * screens never make (`place-with-apartment`).
 */
export function placeWithApartment(): IssueError {
  return new IssueError(
    "A common-area place is for an issue that is not about an apartment.",
    "place-with-apartment",
  );
}

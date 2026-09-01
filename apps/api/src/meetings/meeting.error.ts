import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A refusal from the meetings module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a board is a decision for the screen. The exception
 * filter catches {@link DomainError} once, so nothing has to be registered for
 * this class.
 *
 * ## Why these refusals say what they mean
 *
 * The opposite judgement to the motions module's, and for a reason. There the
 * queue is gated on `motions:handle` and "no such motion" has to answer for a
 * motion that belongs to somebody else, because otherwise the withdraw route
 * reports for any identifier whether a motion exists. Every route here is the
 * board's own, behind one capability, and everybody it can name is a person the
 * caller already reads in the address book. So a refusal that hid which rule it
 * was would leave a board member unable to work out why check-in will not take
 * somebody - at the door, with a queue behind them.
 *
 * What no refusal carries is a name. The codes below name the rule and the
 * identifier the request already supplied, never a person's name and never
 * whether they hold a tenant-ownership beyond the yes or no the request asked
 * for.
 */
export class MeetingError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "meeting-not-found"
      | "meeting-already-held"
      | "meeting-not-held"
      | "agenda-item-not-found"
      | "date-not-a-calendar-date"
      | "not-a-member-on-the-meeting-day"
      | "proxy-holder-not-a-member"
      | "proxy-holder-not-permitted-by-bylaws"
      | "proxy-holder-limit-reached"
      | "proxy-authority-not-yet-issued"
      | "proxy-authority-expired"
      | "proxy-appointment-not-found"
      | "attendance-not-found"
      | "attendance-principal-not-applicable"
      | "assistant-principal-not-present"
      | "proxy-holder-holds-no-authority",
  ) {
    super(message);
    this.status = statusFor(reason);
  }
}

/**
 * The status a reason answers with.
 *
 * A switch over the whole union rather than a chain of ternaries, so a reason
 * added without a status is a compile error rather than a 500 in production.
 */
function statusFor(reason: MeetingError["reason"]): number {
  switch (reason) {
    case "meeting-not-found":
    case "agenda-item-not-found":
    case "proxy-appointment-not-found":
    case "attendance-not-found":
      return HttpStatus.NOT_FOUND;

    case "meeting-already-held":
    case "meeting-not-held":
      /*
       * A conflict: the request is well formed and describes a state the meeting
       * is already in, or is not yet in. This is what a second board member
       * meets clicking the same button, and what somebody meets checking a
       * person in to a meeting that has been closed - neither of which is fixed
       * by sending a different request.
       */
      return HttpStatus.CONFLICT;

    case "not-a-member-on-the-meeting-day":
    case "proxy-holder-not-a-member":
    case "proxy-holder-not-permitted-by-bylaws":
    case "proxy-holder-limit-reached":
    case "proxy-holder-holds-no-authority":
      /*
       * Forbidden, and every one of these is a statement about the statute or
       * about the association's own bylaws rather than about a malformed
       * request. Somebody who is not a member on the meeting day is understood
       * perfectly well and has no vote at that meeting (EFL 6 kap. 3 § with BRL
       * 9 kap. 14 § 1); an ombud who is neither another member nor covered by a
       * bylaws clause may not act (BRL 9 kap. 14 § 4); and a person already
       * carrying as many members as the bylaws allow may not take another.
       */
      return HttpStatus.FORBIDDEN;

    case "proxy-authority-not-yet-issued":
    case "proxy-authority-expired":
      /*
       * Understood and refused on the merits: EFL 6 kap. 4 § holds a fullmakt
       * good for at most a year from the day the member signed it, and a member
       * cannot have signed on a day that has not arrived. Both are facts about
       * the value sent rather than about the meeting, so the caller is told
       * which date is wrong.
       */
      return HttpStatus.UNPROCESSABLE_ENTITY;

    case "date-not-a-calendar-date":
    case "attendance-principal-not-applicable":
    case "assistant-principal-not-present":
      /*
       * The request describes something that is not a date, or not a bitrade.
       * "2027-02-30" is refused rather than read as the 2nd of March, which is
       * what `Date.parse` would make of it; EFL 6 kap. 7 § has a bitrade brought
       * by a member or an ombud, so a bitrade with nobody on the list to have
       * brought them is a request that has not said who they came with; and only
       * a bitrade came with anybody, so naming somebody on a member's or an
       * ombud's line is refused rather than dropped - a field a request set and
       * the server silently ignored is a defect nobody can see.
       */
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

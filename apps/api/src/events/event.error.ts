import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Where in a series a refused value sits.
 *
 * A field name and a position, never the value that was found: the thing the
 * personal-identity-number scan caught is precisely the thing that must not
 * travel back in a response body, into a log, or onto a screen somebody else is
 * looking at. The shape follows the news item's own location type for the same
 * reason it does - a screen has to be able to point at the field.
 */
export interface EventTextLocation {
  field: "title" | "description" | "category" | "location";
  /** Where in that field's text the refused value starts. */
  offset: number;
}

export type EventReason =
  | "not-found"
  | "occurrence-not-found"
  | "personal-identity-number"
  | "invalid-date"
  | "recurrence-interval-invalid"
  | "recurrence-end-required"
  | "recurrence-end-ambiguous"
  | "recurrence-end-invalid"
  | "recurrence-past-horizon"
  | "duration-invalid"
  | "start-does-not-exist"
  | "capacity-not-positive"
  | "occurrence-in-use"
  | "occurrence-already-cancelled"
  | "occurrence-not-cancelled"
  | "occurrence-already-begun"
  | "range-invalid"
  | "signup-not-offered"
  | "occurrence-cancelled"
  | "occurrence-started"
  | "occurrence-full"
  | "already-signed-up"
  | "already-withdrawn"
  | "signup-not-found";

/**
 * A refusal from the events module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a board member is a decision for the screen. The
 * exception filter catches {@link DomainError} once, so nothing has to be
 * registered for this class.
 *
 * The recurrence reasons are separate on purpose. "State an end for the rule",
 * "state one end and not two", "that end is before the series comes round" and
 * "that reaches past the two years a calendar is written out for" are four
 * different mistakes with four different fixes, and one invalid-recurrence code
 * would leave the board member reading it to guess which they made.
 *
 * `occurrence-in-use` is the one refusal that is not about the request at all.
 * The series as stated is coherent and the board may set it; what refuses it is
 * the people who have signed up to a date the change would move or remove. The
 * board's answer is to leave those dates where they are, or to deal with the
 * sign-ups first - which is a decision taken date by date rather than the
 * silent effect of saving a form.
 *
 * ## The three reasons calling a date off and reinstating it do not share
 *
 * `occurrence-already-cancelled` refuses calling off a date that is already off,
 * and `occurrence-not-cancelled` refuses reinstating one that was never called
 * off. Two codes rather than one about "the date is not in the state you think",
 * because the two acts are met by two clicks on the same row and each of them
 * has one sentence to say.
 *
 * `occurrence-already-begun` refuses reinstating a date the clock has passed.
 * It is not `occurrence-started`, which refuses a sign-up to such a date: the
 * two are the same fact refusing two acts, exactly as the pair above is one act
 * refused by two states, and folding them together would put the resident's
 * sentence about sign-ups on the board's screen. What the board can still do
 * with a date that ran while it was called off is nothing - it did not happen,
 * and saying afterwards that it went ahead would make the calendar say something
 * the house can contradict from memory.
 *
 * `range-invalid` is the board calendar's window: a range that runs backwards,
 * or one covering more days than a single read answers for. One code for the
 * whole of it, on the booking calendar's precedent, because the range as a whole
 * is what can be wrong and a screen has one sentence for it.
 *
 * ## The sign-up reasons, and the two that are deliberately vague
 *
 * `occurrence-not-found` answers a date that does not exist AND every date of a
 * series the caller may not read - a draft the board has not published. The
 * alternative would let anybody holding events:attend discover what the board is
 * drafting, one identifier at a time, from the difference between "no such date"
 * and "that date is not taking sign-ups"; the issues module answers a type the
 * caller may not report under exactly as one that does not exist, and the media
 * layer answers a file it will not serve exactly as a file that is not there.
 *
 * `signup-not-found`, on the same reading, answers both a sign-up that does not
 * exist and one that belongs to somebody else. Standing down is only ever an act
 * on one's own sign-up, so anything else is a request for somebody else's row
 * and is answered as absent.
 *
 * The rest are separate for the reason the recurrence reasons are: "that date is
 * not taking sign-ups", "that date has been called off", "that date has already
 * begun", "the places are gone", "you already have a place" and "that sign-up is
 * already withdrawn" are six different facts with six different answers, and the
 * one about the places changes the moment somebody stands down.
 * `occurrence-cancelled` is not the same refusal as
 * `occurrence-already-cancelled`: one refuses signing up to a date the board has
 * called off, the other refuses calling off a date that is already off.
 */
export class EventError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: EventReason,
    private readonly found: {
      locations?: readonly EventTextLocation[];
      /** The local dates an `occurrence-in-use` refusal is about, YYYY-MM-DD. */
      dates?: readonly string[];
    } = {},
  ) {
    super(message);
    this.status = statusFor(reason);
  }

  /**
   * The particulars the refusal publishes.
   *
   * Field names, offsets and calendar dates: what a screen needs to point at
   * the problem, and nothing that could be a value. The dates an
   * `occurrence-in-use` refusal names are the association's own calendar rather
   * than anybody's data - which of them somebody signed up to is not said, and
   * who did is never said.
   */
  override details(): Record<string, readonly unknown[]> {
    return {
      locations: this.found.locations ?? [],
      dates: this.found.dates ?? [],
    };
  }
}

/**
 * The status a reason answers with.
 *
 * A switch over the whole union rather than a chain of ternaries, so a reason
 * added without a status is a compile error rather than a 500 in production.
 */
function statusFor(reason: EventReason): number {
  switch (reason) {
    case "not-found":
    case "occurrence-not-found":
    case "signup-not-found":
      return HttpStatus.NOT_FOUND;

    case "occurrence-in-use":
    case "occurrence-already-cancelled":
    case "occurrence-not-cancelled":
    case "occurrence-already-begun":
    case "signup-not-offered":
    case "occurrence-cancelled":
    case "occurrence-started":
    case "occurrence-full":
    case "already-signed-up":
    case "already-withdrawn":
      /*
       * A conflict rather than an unprocessable entity: the request is well
       * formed, the caller may see what it names, and it describes a state the
       * thing is already in, or one it cannot be moved to while other rows
       * stand. Mostly a state that does not stay true - a place refused because
       * the date is full is there again the moment somebody stands down - and
       * none of them is fixed by sending a different request.
       *
       * The two about a date having begun are here for the first half of that
       * and not the second: the clock will not give the date back. They are
       * still the thing's own state rather than a fault in what was stated,
       * which is what separates this bucket from the one below.
       */
      return HttpStatus.CONFLICT;

    case "range-invalid":
    case "personal-identity-number":
    case "invalid-date":
    case "recurrence-interval-invalid":
    case "recurrence-end-required":
    case "recurrence-end-ambiguous":
    case "recurrence-end-invalid":
    case "recurrence-past-horizon":
    case "duration-invalid":
    case "start-does-not-exist":
    case "capacity-not-positive":
      // Understood and refused on its merits: the shape was right, and the
      // board is told which part of what they stated to change.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

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
  | "occurrence-already-cancelled";

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
      return HttpStatus.NOT_FOUND;

    case "occurrence-in-use":
    case "occurrence-already-cancelled":
      /*
       * A conflict rather than an unprocessable entity: the request is well
       * formed, the caller may see what it names, and it describes a state the
       * thing is already in, or one it cannot be moved to while other rows
       * stand. Neither stays true for ever, and neither is fixed by sending a
       * different request.
       */
      return HttpStatus.CONFLICT;

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

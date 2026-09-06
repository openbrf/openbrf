import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Where in a charge a refused value sits.
 *
 * A field name and a position, never the value that was found: the thing the
 * personal-identity-number scan caught is precisely the thing that must not
 * travel back in a response body, into a log, or onto a screen somebody else is
 * looking at. The shape follows the event calendar's own location type for the
 * same reason it does - a screen has to be able to point at the field.
 *
 * One field, because the reason is the only free text a charge carries. It is
 * still a list of locations rather than a boolean: a board member who pasted a
 * paragraph in wants to be shown where in it the number is.
 */
export interface MemberChargeTextLocation {
  field: "reason";
  /** Where in that field's text the refused value starts. */
  offset: number;
}

export type MemberChargeReason =
  | "not-found"
  | "person-not-found"
  | "apartment-not-found"
  | "party-required"
  | "party-ambiguous"
  | "personal-identity-number"
  | "date-not-a-calendar-date"
  | "date-in-the-future"
  | "amount-not-a-sum"
  | "amount-not-positive"
  | "reason-required"
  | "vat-rate-required"
  | "vat-rate-not-applicable"
  | "vat-rate-out-of-range"
  | "handed-over-before-charge"
  | "handed-over-in-the-future"
  | "range-invalid";

/**
 * A refusal from the charges module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a board member is a decision for the screen. The
 * exception filter catches {@link DomainError} once, so nothing has to be
 * registered for this class.
 *
 * ## The two about who is charged
 *
 * `party-required` refuses a charge naming neither a person nor an apartment,
 * and `party-ambiguous` one naming both. Two codes rather than one about "the
 * charged party is wrong", because they are met by two different corrections:
 * one board member has filled in nothing and the other has filled in one field
 * too many, and the second is the likelier mistake on a form that offers both.
 *
 * Both are stated as refusals rather than resolved by a rule. A charge naming a
 * person and an apartment could be read as "the person, and here is where they
 * live" - and the day the apartment changed hands the row would have two answers
 * to who is being charged and no way to say which it meant.
 *
 * ## The date
 *
 * `date-in-the-future` refuses dating a charge ahead of today. The charge is the
 * basis for something that has happened - a key handed over, a repair done - and
 * a sum dated into next month is either a mistake or the recurring charge that
 * belongs to the paid module. Refusing it here is what keeps this table the basis
 * rather than a schedule.
 *
 * `handed-over-before-charge` is the same kind of rule read between two dates:
 * the basis cannot have reached the bookkeeper before the charge it is the basis
 * for was made. `handed-over-in-the-future` refuses recording a hand-over that
 * has not happened yet, on the same reading as the charge date.
 *
 * ## The two about the amount
 *
 * `amount-not-a-sum` refuses text that is not a sum of kronor and ore at all, or
 * one with more places than the column holds. `amount-not-positive` refuses zero
 * and a negative. They are separate because the fixes are: one is a typing
 * mistake, the other is somebody trying to enter a credit, and a credit is not a
 * charge with a minus sign in front of it - it is an act the accounting system
 * takes, and this table holds the basis rather than the ledger.
 *
 * ## The three about VAT
 *
 * `vat-rate-required` refuses a rated charge with no rate, `vat-rate-not-
 * applicable` an exempt one carrying a rate, and `vat-rate-out-of-range` a rate
 * that could not be one. Three, because a screen has one sentence for each and
 * they name three different fields to change. The last is a bound and not a list
 * of the rates in force: those are mervardesskattelagen's, they move by
 * amendment, and a platform refusing a rate a board has been told to apply would
 * be enforcing a table it has no business keeping.
 *
 * `range-invalid` is the debiting list's window: a period that runs backwards.
 * One code for the whole of it, on the booking calendar's precedent, because the
 * range as a whole is what can be wrong and a screen has one sentence for it.
 */
export class MemberChargeError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: MemberChargeReason,
    private readonly found: {
      locations?: readonly MemberChargeTextLocation[];
    } = {},
  ) {
    super(message);
    this.status = statusFor(reason);
  }

  /**
   * The particulars the refusal publishes.
   *
   * Field names and offsets: what a screen needs to point at the problem, and
   * nothing that could be a value.
   */
  override details(): Record<string, readonly unknown[]> {
    return { locations: this.found.locations ?? [] };
  }
}

/**
 * The status a reason answers with.
 *
 * A switch over the whole union rather than a chain of ternaries, so a reason
 * added without a status is a compile error rather than a 500 in production.
 */
function statusFor(reason: MemberChargeReason): number {
  switch (reason) {
    case "not-found":
    case "person-not-found":
    case "apartment-not-found":
      /*
       * A person or an apartment the register does not hold is answered as
       * absent rather than as an invalid field, and so is a charge that is not
       * there. Everyone who can reach these routes may read the whole register,
       * so nothing is being concealed here - it is simply the truthful answer.
       */
      return HttpStatus.NOT_FOUND;

    case "party-required":
    case "party-ambiguous":
    case "personal-identity-number":
    case "date-not-a-calendar-date":
    case "date-in-the-future":
    case "amount-not-a-sum":
    case "amount-not-positive":
    case "reason-required":
    case "vat-rate-required":
    case "vat-rate-not-applicable":
    case "vat-rate-out-of-range":
    case "handed-over-before-charge":
    case "handed-over-in-the-future":
    case "range-invalid":
      // Understood and refused on its merits: the shape was right, and the
      // board is told which part of what they stated to change.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

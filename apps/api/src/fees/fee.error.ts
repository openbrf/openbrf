import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

export type FeeReason =
  | "not-found"
  | "apartment-not-found"
  | "housing-cooperative-missing"
  | "date-not-a-calendar-date"
  | "amount-not-a-sum"
  | "amount-not-positive"
  | "vat-rate-required"
  | "vat-rate-not-applicable"
  | "vat-rate-out-of-range"
  | "ends-before-it-begins"
  | "fee-already-recorded-later"
  | "fee-already-in-force"
  | "fee-notified"
  | "period-not-whole-months"
  | "period-too-long"
  | "period-already-issued"
  | "period-overlaps-a-run"
  | "due-before-period"
  | "nothing-to-bill"
  | "too-many-notices";

/**
 * A refusal from the fees module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a board member is a decision for the screen. The
 * exception filter catches {@link DomainError} once, so nothing has to be
 * registered for this class.
 *
 * ## The three about a rate's dates
 *
 * `ends-before-it-begins` is the ordinary bound. `fee-already-recorded-later`
 * refuses recording a rate that starts on or before one already recorded for
 * the same apartment and kind: rates are a history, the act of recording one
 * closes the rate before it, and inserting behind that would leave two rates
 * covering one day with no answer to which the apartment pays. The board
 * removes the later rate and records both in order, which is the correction
 * that says what happened.
 *
 * `fee-already-in-force` refuses a rate starting inside the window of one that
 * is already closed - the state removing the rate that closed it leaves behind.
 * Its own code, because it is met by a different correction: the new rate starts
 * the day after that one ends, or that one is removed first.
 *
 * A rate dated forward is not refused at all, and that absence is the point.
 * It is the whole difference from `charges/member-charge.error.ts`'s
 * `date-in-the-future`: a rate dated forward is the board recording a decision
 * it has taken, while a charge dated forward is a claim that something happened
 * which has not.
 *
 * `fee-notified` refuses removing a rate a notification run has already billed
 * from. The notice is that money's basis, and bokforingslagen 7 kap. 1 §
 * forbids altering preserved rakenskapsinformation; the rate is ended rather
 * than removed once it has been billed.
 *
 * ## The four about a period
 *
 * `period-not-whole-months` refuses a period that does not open on the first of
 * a month and close on the last of one. A rate is stated per calendar month and
 * what an apartment owes is that figure multiplied by the months in the period,
 * which is exact in ore; a part month would need a division of kronor by days,
 * and this product refuses a malformed amount rather than rounding one.
 * `period-too-long` is the bound that keeps a typing mistake from building a
 * query per month for a century.
 *
 * `period-already-issued` and `period-overlaps-a-run` are the same rule read
 * two ways: a period may be issued once. Two codes rather than one, because
 * they are met by two different corrections - the board has either already done
 * this exact run, or is about to bill a month twice under two different sets of
 * references.
 *
 * `due-before-period` bounds the due date to the period it bills. Nothing
 * computes from a due date - BRL 7 kap. 18 § makes an unpaid arsavgift a ground
 * for forverkande of the nyttjanderatt and a platform counting those days would
 * be running a forfeiture procedure - so this is a bound on a field and not a
 * rule about payment.
 *
 * ## The two about what comes out
 *
 * `nothing-to-bill` refuses a run that would produce no notices at all. An
 * empty run records that the board issued the period's notices when it issued
 * none, and it would take the period's number in the sequence with it.
 * `too-many-notices` refuses a run larger than the payment reference format can
 * number, which is stated in `payment-reference.ts` rather than here.
 */
export class FeeError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: FeeReason,
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
function statusFor(reason: FeeReason): number {
  switch (reason) {
    case "not-found":
    case "apartment-not-found":
      /*
       * An apartment the register does not hold is answered as absent rather
       * than as an invalid field, and so is a fee that is not there. Everyone
       * who can reach these routes may read the whole register, so nothing is
       * being concealed here - it is simply the truthful answer.
       */
      return HttpStatus.NOT_FOUND;

    case "housing-cooperative-missing":
    case "period-already-issued":
    case "period-overlaps-a-run":
    case "fee-already-recorded-later":
    case "fee-already-in-force":
    case "fee-notified":
      /*
       * The request was well formed and refused by the state of the instance
       * rather than by its own contents. The settings module answers a missing
       * housing cooperative the same way, and a board meeting one of these is
       * told what stands in the way rather than which field to change.
       */
      return HttpStatus.CONFLICT;

    case "date-not-a-calendar-date":
    case "amount-not-a-sum":
    case "amount-not-positive":
    case "vat-rate-required":
    case "vat-rate-not-applicable":
    case "vat-rate-out-of-range":
    case "ends-before-it-begins":
    case "period-not-whole-months":
    case "period-too-long":
    case "due-before-period":
    case "nothing-to-bill":
    case "too-many-notices":
      // Understood and refused on its merits: the shape was right, and the
      // board is told which part of what they stated to change.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the fees screen can meet, in one sentence each.
 *
 * The API answers with a code rather than a sentence, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * a decision for the screen.
 *
 * A 403 is answered before the map is consulted at all; see
 * {@link failureMessageKey}.
 */

/**
 * The reasons the fees module refuses with.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client, and written out in full rather than left as `string`:
 * the map below is checked against it, so a reason the server gains and this
 * client has no sentence for is a compile error here rather than "something went
 * wrong" on a board member's screen.
 */
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
  | "fee-notified"
  | "period-not-whole-months"
  | "period-too-long"
  | "period-already-issued"
  | "period-overlaps-a-run"
  | "due-before-period"
  | "nothing-to-bill"
  | "too-many-notices";

/**
 * Every reason, and the sentence it becomes.
 *
 * Total over {@link FeeReason} and checked as such, so the map cannot fall
 * behind the API by one code. `invalid-body` is the endpoint's own schema
 * refusal and is the one key here that is not a domain reason - for these forms
 * it means a value the screen should not have been able to send.
 *
 * The pairs stay pairs. A period already issued and a period overlapping one
 * are two mistakes with two corrections - the board has either already done
 * this run, or is about to bill a month twice - and so are a rate on an exempt
 * fee and a taxable fee with no rate. One sentence about the period or about
 * value added tax would leave the board member guessing which half of the form
 * to change.
 */
const FEE_FAILURES: Readonly<
  Record<FeeReason | "invalid-body", TranslationKey>
> = {
  "not-found": "fees.errors.notFound",
  "apartment-not-found": "fees.errors.apartmentNotFound",
  "housing-cooperative-missing": "settings.errors.housingCooperativeMissing",

  "date-not-a-calendar-date": "fees.errors.dateNotACalendarDate",
  "amount-not-a-sum": "fees.errors.amountNotASum",
  "amount-not-positive": "fees.errors.amountNotPositive",

  "vat-rate-required": "fees.errors.vatRateRequired",
  "vat-rate-not-applicable": "fees.errors.vatRateNotApplicable",
  "vat-rate-out-of-range": "fees.errors.vatRateOutOfRange",

  "ends-before-it-begins": "fees.errors.endsBeforeItBegins",
  // The two about a rate's place in its own history.
  "fee-already-recorded-later": "fees.errors.feeAlreadyRecordedLater",
  "fee-notified": "fees.errors.feeNotified",

  "period-not-whole-months": "fees.errors.periodNotWholeMonths",
  "period-too-long": "fees.errors.periodTooLong",
  "period-already-issued": "fees.errors.periodAlreadyIssued",
  "period-overlaps-a-run": "fees.errors.periodOverlapsARun",
  "due-before-period": "fees.errors.dueBeforePeriod",

  "nothing-to-bill": "fees.errors.nothingToBill",
  "too-many-notices": "fees.errors.tooManyNotices",

  "invalid-body": "fees.errors.invalidBody",
};

/** The sentence a refusal becomes. */
export function feeFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(failure, FEE_FAILURES, "fees.errors.unknown");
}

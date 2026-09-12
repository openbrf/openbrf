import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the charges screen can meet, in one sentence each.
 *
 * The API answers with a code rather than a sentence, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * a decision for the screen.
 *
 * A 403 is answered before the map is consulted at all; see
 * {@link failureMessageKey}.
 */

/**
 * The reasons the charges module refuses with.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client, and written out in full rather than left as `string`:
 * the map below is checked against it, so a reason the server gains and this
 * client has no sentence for is a compile error here rather than "something went
 * wrong" on a board member's screen.
 */
export type ChargeReason =
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
 * Every reason, and the sentence it becomes.
 *
 * Total over {@link ChargeReason} and checked as such, so the map cannot fall
 * behind the API by one code. `invalid-body` is the endpoint's own schema
 * refusal and is the one key here that is not a domain reason - for this form it
 * means a value the screen should not have been able to send.
 *
 * The pairs stay pairs. "Name somebody" and "name one and not two" are two
 * mistakes with two corrections; so are a rate on an exempt charge and a rated
 * charge with no rate. One sentence about the charged party or about VAT would
 * leave the board member guessing which half of the form to change.
 */
const CHARGE_FAILURES: Readonly<
  Record<ChargeReason | "invalid-body", TranslationKey>
> = {
  "not-found": "charges.errors.notFound",
  "person-not-found": "charges.errors.personNotFound",
  "apartment-not-found": "charges.errors.apartmentNotFound",

  "party-required": "charges.errors.partyRequired",
  "party-ambiguous": "charges.errors.partyAmbiguous",

  // The guardrail on the one free-text field, and the only refusal that names
  // where in it the problem is.
  "personal-identity-number": "charges.errors.personalIdentityNumber",

  "date-not-a-calendar-date": "charges.errors.dateNotACalendarDate",
  "date-in-the-future": "charges.errors.dateInTheFuture",
  "amount-not-a-sum": "charges.errors.amountNotASum",
  "amount-not-positive": "charges.errors.amountNotPositive",
  "reason-required": "charges.errors.reasonRequired",
  "vat-rate-required": "charges.errors.vatRateRequired",
  "vat-rate-not-applicable": "charges.errors.vatRateNotApplicable",
  "vat-rate-out-of-range": "charges.errors.vatRateOutOfRange",
  "handed-over-before-charge": "charges.errors.handedOverBeforeCharge",
  "handed-over-in-the-future": "charges.errors.handedOverInTheFuture",

  // The period, which the screen's own date controls cannot produce - so this
  // is what the board reads if an address was edited by hand.
  "range-invalid": "charges.errors.rangeInvalid",

  "invalid-body": "charges.errors.invalidBody",
};

/** The sentence a refusal becomes. */
export function chargeFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(failure, CHARGE_FAILURES, "charges.errors.unknown");
}

/**
 * Whether a refusal is the personal-identity-number scan, and where it hit.
 *
 * The offsets are on the refusal because a board member who pasted a paragraph
 * in wants to be shown where in it the number is. The count is what the screen
 * says; the offsets are not rendered as numbers, because "at character 12" is
 * not how anybody reads their own sentence.
 */
export function refusedIdentityNumbers(failure: ApiFailure): number {
  if (failure.reason !== "personal-identity-number") {
    return 0;
  }
  const detail = failure.detail;
  return Array.isArray(detail) ? detail.length : 0;
}

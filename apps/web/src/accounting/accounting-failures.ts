import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the accounting basis export can meet, in one sentence each.
 *
 * The API answers with a code rather than a sentence, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * a decision for the screen.
 *
 * A 403 is answered before the map is consulted at all; see
 * {@link failureMessageKey}. It is the seat holding one of the two
 * capabilities the file needs and not the other, which is the one refusal here
 * that is not about the period.
 */

/**
 * The reasons the export refuses with.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client, and written out in full rather than left as `string`:
 * the map below is checked against it, so a reason the server gains and this
 * client has no sentence for is a compile error here rather than "something
 * went wrong" on a board member's screen.
 */
export type AccountingReason =
  "housing-cooperative-missing" | "date-not-a-calendar-date" | "range-invalid";

/**
 * Every reason, and the sentence it becomes.
 *
 * Total over {@link AccountingReason} and checked as such, so the map cannot
 * fall behind the API by one code. `invalid-body` is the endpoint's own schema
 * refusal and is the one key here that is not a domain reason - for this form
 * it means a date the screen should not have been able to send.
 */
const ACCOUNTING_FAILURES: Readonly<
  Record<AccountingReason | "invalid-body", TranslationKey>
> = {
  "housing-cooperative-missing": "settings.errors.housingCooperativeMissing",
  "date-not-a-calendar-date": "accounting.errors.dateNotACalendarDate",
  "range-invalid": "accounting.errors.rangeInvalid",
  "invalid-body": "accounting.errors.invalidBody",
};

/** The sentence a refusal becomes. */
export function accountingFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(
    failure,
    ACCOUNTING_FAILURES,
    "accounting.errors.unknown",
  );
}

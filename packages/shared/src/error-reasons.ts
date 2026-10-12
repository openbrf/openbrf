/**
 * The machine-readable reasons a domain refusal travels with.
 *
 * A refusal crosses the wire as a code rather than a sentence, because the
 * interface is Swedish and the server's messages are English. The API types the
 * code it throws with these unions and the web types the map from code to
 * sentence with them, so a reason added here and given a status on the server
 * but no sentence in the browser fails the web build instead of reaching a
 * board member as the general fallback.
 *
 * They live here rather than beside the error classes because both applications
 * read them and neither may import the other's code.
 */

/** What the move-in, move-out and transfer endpoints refuse with. */
export type MoveErrorReason =
  | "person-not-found"
  | "apartment-not-found"
  | "residency-not-found"
  | "already-resident"
  | "already-moved-out"
  | "moved-out-before-moved-in"
  | "transfer-person-not-found"
  | "transfer-reference-required"
  | "grant-has-no-seller"
  | "date-not-a-calendar-date"
  | "seller-is-acquirer"
  | "seller-not-tenant-owner"
  | "transfer-without-tenant-ownership"
  | "already-granted";

/** What the accounting basis export refuses with. */
export type AccountingReason =
  "housing-cooperative-missing" | "date-not-a-calendar-date" | "range-invalid";

/** What the fees module refuses with. */
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
  | "period-already-notified"
  | "period-not-whole-months"
  | "period-too-long"
  | "period-already-issued"
  | "period-overlaps-a-run"
  | "due-before-period"
  | "nothing-to-bill"
  | "too-many-notices"
  | "amount-too-large"
  | "period-past-retention"
  | "payment-reference-reused";

/** What the charges module refuses with. */
export type MemberChargeReason =
  | "not-found"
  | "person-not-found"
  | "apartment-not-found"
  | "party-required"
  | "party-ambiguous"
  | "personal-identity-number"
  | "date-not-a-calendar-date"
  | "date-in-the-future"
  | "date-beyond-retention"
  | "amount-not-a-sum"
  | "amount-not-positive"
  | "reason-required"
  | "vat-rate-required"
  | "vat-rate-not-applicable"
  | "vat-rate-out-of-range"
  | "handed-over-before-charge"
  | "handed-over-in-the-future"
  | "range-invalid";

/** What the meetings module refuses with. */
export type MeetingReason =
  | "meeting-not-found"
  | "meeting-already-held"
  | "meeting-not-held"
  | "meeting-day-in-the-future"
  | "agenda-item-not-found"
  | "date-not-a-calendar-date"
  | "not-a-member-on-the-meeting-day"
  | "proxy-holder-not-a-member"
  | "proxy-holder-not-permitted-by-bylaws"
  | "proxy-holder-limit-reached"
  | "proxy-authority-not-yet-issued"
  | "proxy-authority-expired"
  | "proxy-authorisation-not-found"
  | "attendance-not-found"
  | "attendance-principal-not-applicable"
  | "assistant-principal-not-present"
  | "assistant-already-present"
  | "assistant-is-their-own-principal"
  | "proxy-holder-is-the-member"
  | "proxy-holder-holds-no-authority"
  | "notice-already-issued"
  | "meeting-has-no-agenda"
  | "notice-time-not-on-the-meeting-day";

/** What turning a connected app away for the whole instance refuses with. */
export type ConnectedAppRevocationReason = "client-not-found";

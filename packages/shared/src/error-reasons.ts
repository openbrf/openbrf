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
 *
 * The parts and fields beside some of them are the other half of the same
 * contract: a refusal for a personal identity number names where it found one,
 * never the value, and the screen points the reader at that field. A part the
 * server renames and the browser does not know is dropped there rather than
 * shown, so it is typed from here as well.
 */

/** What the move-in, move-out and transfer endpoints refuse with. */
export type MoveReason =
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

/** What the sublets module refuses with. */
export type SubletReason =
  | "not-a-member"
  | "apartment-not-found"
  | "application-not-found"
  | "already-closed"
  | "not-refused"
  | "invalid-period"
  | "period-too-far-ahead"
  | "personal-identity-number";

/**
 * Where in a subletting application a refused value sits: the applicant's own
 * reason, or the note the board wrote when it answered.
 */
export type SubletTextPart = "reason" | "decisionNote";

/**
 * What the motions module refuses with.
 *
 * Read from three directions: the API's statuses, the browser's sentences and
 * the action catalogue, which publishes a verdict for each member.
 */
export type MotionReason =
  | "not-a-member"
  | "motion-not-found"
  | "already-closed"
  | "motion-withdrawn"
  | "meeting-not-found"
  | "meeting-already-held"
  | "meeting-notice-issued"
  | "meeting-changed-meanwhile"
  | "personal-identity-number";

/** Where in a motion a refused value sits. */
export type MotionTextPart = "title" | "body";

/** What the events module refuses with. */
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

/** Which field of an event series a refused value sits in. */
export type EventTextField = "title" | "description" | "category" | "location";

/** What the key orders module refuses with. */
export type KeyOrderReason =
  | "apartment-not-found"
  | "order-not-found"
  | "already-closed"
  | "personal-identity-number";

/**
 * Where in a key order a refused value sits: the resident's note, or the one
 * the board wrote when it answered.
 */
export type KeyOrderTextPart = "note" | "boardNote";

/** What the apartment binder refuses with, about the entry itself. */
export type ApartmentBinderReason =
  | "not-found"
  | "kind-is-the-boards"
  | "date-required"
  | "personal-identity-number"
  | "binder-full";

/** Where in a binder filing a refused value sits. */
export type ApartmentBinderTextPart = "title" | "fileName";

/**
 * What an upload is refused with.
 *
 * Every route that takes a file can answer with these as well as with its own
 * module's reasons, because the file is read and stored by the media module.
 */
export type MediaReason =
  | "no-file"
  | "empty-file"
  | "too-large"
  | "unsupported-type"
  | "declaration-required"
  | "not-found"
  | "forbidden";

/** What the chat refuses with. */
export type ChatReason =
  | "chat-not-found"
  | "message-not-found"
  | "report-not-found"
  | "report-resolved"
  | "not-a-resident"
  | "not-reportable"
  | "too-many-groups"
  | "group-full"
  | "already-reported"
  | "personal-identity-number"
  | "too-many-messages";

/** What the website's page write endpoints refuse with. */
export type PageWriteReason =
  | "not-found"
  | "invalid-slug"
  | "slug-taken"
  | "page-changed"
  | "personal-identity-number"
  | "photo-consent-required"
  | "image-not-found"
  | "image-not-public";

/** What the news comment thread refuses with. */
export type NewsCommentReason =
  | "news-not-found"
  | "comment-not-found"
  | "personal-identity-number"
  | "too-many-comments";

/**
 * What the booking module refuses with: booking and cancelling, and writing
 * the bookable resources themselves.
 */
export type BookingReason =
  | "resource-not-found"
  | "resource-deactivated"
  | "resource-in-use"
  | "schedule-required"
  | "schedule-not-applicable"
  | "closes-before-opens"
  | "slot-does-not-fit"
  | "quota-not-positive"
  | "personal-identity-number"
  | "booking-not-found"
  | "apartment-not-found"
  | "range-invalid"
  | "slot-not-bookable"
  | "slot-taken"
  | "quota-reached"
  | "already-cancelled"
  | "booking-started"
  | "booking-ended";

/** Which field of a bookable resource a refused value sits in. */
export type BookingTextField = "name" | "description";

/** What turning a connected app away for the whole instance refuses with. */
export type ConnectedAppRevocationReason = "client-not-found";

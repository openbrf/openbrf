import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the booking screen can meet, in words.
 *
 * The API answers with a code rather than a sentence, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * a decision for the screen. So this is where the module's refusals become
 * something a resident or a board member can act on.
 *
 * Held in one module rather than in each panel because all three panels can
 * meet most of the same refusals: the slot grid, the my-bookings list and the
 * board's view all cancel or book against the same rules, and three copies of
 * the map would drift into three different sentences for one fact.
 *
 * The refusals only a resource write can meet - a slot length that does not fit
 * the opening hours, opening hours on a resource that has none, a personal
 * identity number in the name or the description, and so on - are deliberately
 * absent. They are not reachable from these screens, and the settings panel
 * that can reach them words them for the board member who is configuring the
 * thing rather than for the resident meeting the result.
 *
 * A refusal none of these keys covers falls through to the fallback below, and
 * a 403 is answered before the map is consulted at all. See
 * {@link failureMessageKey}.
 */
const BOOKING_FAILURES: Readonly<Record<string, TranslationKey>> = {
  /*
   * The two the calendar itself can go stale about. A resource cannot be
   * deleted, so `resource-not-found` needs a board to have removed a row by
   * hand - but a code reaching a resident is a worse answer than a sentence,
   * and this one is a sentence.
   */
  "resource-not-found": "bookings.errors.resourceNotFound",
  "resource-deactivated": "bookings.errors.resourceWithdrawn",

  /*
   * The claim. `slot-taken` is the race the database arbitrates and the one
   * refusal a resident meets through no fault of their own;
   * `slot-not-bookable` is the slot that began while the page was open, or a
   * period the resource stopped offering when the board narrowed its hours.
   */
  "slot-taken": "bookings.errors.slotTaken",
  "slot-not-bookable": "bookings.errors.slotNotBookable",
  "quota-reached": "bookings.errors.quotaReached",
  "apartment-not-found": "bookings.errors.apartmentNotFound",

  /*
   * Cancelling. `booking-not-found` also answers a booking belonging to
   * somebody else, which is why the sentence says the booking is gone rather
   * than that it is not the reader's: the endpoint deliberately cannot be used
   * to find out who holds an hour, and a sentence that distinguished the two
   * would undo that.
   */
  "booking-not-found": "bookings.errors.bookingNotFound",
  "already-cancelled": "bookings.errors.alreadyCancelled",

  /*
   * The calendar window. Reachable only from a read, and only if the window
   * this client computes is malformed - so the sentence tells the reader to
   * reload rather than asking them to fix something they never chose.
   */
  "range-invalid": "bookings.errors.rangeInvalid",

  /*
   * The endpoint's own schema refusal, which for these forms means a value the
   * screen should not have been able to send.
   */
  "invalid-body": "bookings.errors.unknown",
};

/**
 * The sentence for a booking refusal.
 *
 * A wrapper around the shared helper for one reason: `quota-reached` is two
 * different situations behind one code, and the API says which. A weekly
 * allowance that has been spent is waited out; a limit on how much of the
 * future one household may hold at once is fixed by cancelling something. A
 * single sentence would leave the reader guessing which of those they are in,
 * so the limit the API names picks the sentence, and the generic one stands
 * when it names none.
 */
export function bookingFailureKey(failure: ApiFailure): TranslationKey {
  const key = failureMessageKey(
    failure,
    BOOKING_FAILURES,
    "bookings.errors.unknown",
  );
  if (key !== "bookings.errors.quotaReached") {
    return key;
  }
  /*
   * Refined only by a limit this client recognises. A refusal that named none,
   * or named one added to the API since this build, keeps the sentence that is
   * true of both - which is why the generic key exists rather than one of the
   * two standing in for it.
   */
  switch (quotaLimitOf(failure)) {
    case "maxBookingsPerWeek":
      return "bookings.errors.quotaWeek";
    case "maxConcurrentBookings":
      return "bookings.errors.quotaConcurrent";
    default:
      return "bookings.errors.quotaReached";
  }
}

/**
 * Which limit a quota refusal named, when it named one.
 *
 * `ApiFailure.detail` is `unknown` and endpoint-specific, so it is narrowed
 * here rather than trusted: this refusal publishes the field name of the limit
 * that was reached, which is configuration the caller is subject to and not
 * anybody's data.
 */
function quotaLimitOf(failure: ApiFailure): string | null {
  if (!Array.isArray(failure.detail)) {
    return null;
  }
  const [limit] = failure.detail;
  return typeof limit === "string" ? limit : null;
}

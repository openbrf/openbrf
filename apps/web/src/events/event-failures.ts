import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the event screen can meet, in one sentence each.
 *
 * The API answers with a code rather than a sentence, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * a decision for the screen. So this is where the module's refusals become
 * something a resident or a board member can act on.
 *
 * Held in one module rather than in each panel because both halves can meet the
 * same refusals: a date that has been called off refuses a sign-up and refuses
 * being called off again, and two copies of the map would drift into two
 * sentences for one fact.
 *
 * A 403 is answered before the map is consulted at all; see
 * {@link failureMessageKey}.
 */

/**
 * The reasons the events module refuses with.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client, and written out in full rather than left as `string`:
 * the map below is checked against it, so a reason the server gains and this
 * client has no sentence for is a compile error here rather than "something went
 * wrong" on a board member's screen.
 */
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
  | "signup-not-offered"
  | "occurrence-cancelled"
  | "occurrence-started"
  | "occurrence-full"
  | "already-signed-up"
  | "already-withdrawn"
  | "signup-not-found";

/**
 * The parts of a series a personal-identity-number refusal can name.
 *
 * Mirrored from the API's own location type. Narrower than `string` on purpose:
 * see {@link scannedFields}.
 */
export type EventTextField = "title" | "description" | "category" | "location";

const EVENT_TEXT_FIELDS: readonly string[] = [
  "title",
  "description",
  "category",
  "location",
];

/**
 * Every reason, and the sentence it becomes.
 *
 * Total over {@link EventReason} and checked as such, so the map cannot fall
 * behind the API by one code. `invalid-body` is the endpoint's own schema
 * refusal and is the one key here that is not a domain reason - for these forms
 * it means a value the screen should not have been able to send.
 *
 * The four recurrence reasons stay four sentences. "State an end for the rule",
 * "state one end and not two", "that end is before the series comes round" and
 * "that reaches past the two years a calendar is written out for" are four
 * different mistakes with four different fixes, and one sentence about an
 * invalid rule would leave the board member reading it to guess which they made.
 *
 * `occurrence-cancelled` and `occurrence-already-cancelled` are likewise not one
 * refusal: one refuses signing up to a date the board has called off, the other
 * refuses calling off a date that is already off, and they are met by different
 * people on different halves of the screen.
 */
const EVENT_FAILURES: Readonly<Record<string, TranslationKey>> = {
  // The two reads that can go stale under either half of the screen.
  "not-found": "events.errors.notFound",
  "occurrence-not-found": "events.errors.occurrenceNotFound",

  // The guardrail on publication, and the only refusal that names where.
  "personal-identity-number": "events.errors.personalIdentityNumber",

  /*
   * What the board stated, refused on its merits. Each of these names one field
   * of the form to change, which is why none of them is folded into another.
   */
  "invalid-date": "events.errors.invalidDate",
  "recurrence-interval-invalid": "events.errors.recurrenceIntervalInvalid",
  "recurrence-end-required": "events.errors.recurrenceEndRequired",
  "recurrence-end-ambiguous": "events.errors.recurrenceEndAmbiguous",
  "recurrence-end-invalid": "events.errors.recurrenceEndInvalid",
  "recurrence-past-horizon": "events.errors.recurrencePastHorizon",
  "duration-invalid": "events.errors.durationInvalid",
  "start-does-not-exist": "events.errors.startDoesNotExist",
  "capacity-not-positive": "events.errors.capacityNotPositive",

  /*
   * The one refusal that is not about the request. The series as stated is
   * coherent; what refuses it is the people standing on a date the change would
   * move. The sentence points the board at the dates the refusal names, which is
   * what {@link refusedDates} reads off it.
   */
  "occurrence-in-use": "events.errors.occurrenceInUse",
  "occurrence-already-cancelled": "events.errors.occurrenceAlreadyCancelled",

  /*
   * Signing up, and standing down. `occurrence-full` is the race the lock
   * arbitrates and the one refusal a resident meets through no fault of their
   * own - and the one whose sentence has to survive being read next to a count
   * that has just been read again.
   */
  "signup-not-offered": "events.errors.signupNotOffered",
  "occurrence-cancelled": "events.errors.occurrenceCancelled",
  "occurrence-started": "events.errors.occurrenceStarted",
  "occurrence-full": "events.errors.occurrenceFull",
  "already-signed-up": "events.errors.alreadySignedUp",
  "already-withdrawn": "events.errors.alreadyWithdrawn",
  /*
   * Answers both a sign-up that does not exist and one belonging to somebody
   * else, which is why the sentence says it is gone rather than that it is not
   * the reader's: the endpoint deliberately cannot be used to find out who is
   * coming, and a sentence that told the two apart would undo that.
   */
  "signup-not-found": "events.errors.signupNotFound",

  "invalid-body": "events.errors.invalidBody",
} satisfies Record<EventReason | "invalid-body", TranslationKey>;

/** The sentence for a refusal from this module. */
export function eventFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(failure, EVENT_FAILURES, "events.errors.unknown");
}

/**
 * Which fields of a series carried a personal identity number.
 *
 * Read off the refusal's `locations`, which carry a field name and an offset and
 * never the value that was found. Only the field names are used: telling a board
 * member "there is a personal identity number in the description" is actionable,
 * and quoting the number back onto the screen would be the disclosure the scan
 * exists to prevent. The offset is not rendered either, on the reading the
 * motion form applies to the same refusal - a character position in a textarea
 * is not something a person acts on, and the field is.
 *
 * A field name this client does not know is dropped rather than carried through.
 * The screen has one sentence per field and no honest way to render a fifth, so
 * an unrecognised name would have to be folded into one of the four it has - and
 * pointing a board member at the wrong field sends them editing text that holds
 * nothing, which leaves the personal identity number where it is and the series
 * refused again. Saying less than the response did is the direction to fail in.
 */
export function scannedFields(failure: ApiFailure): readonly EventTextField[] {
  if (!Array.isArray(failure.detail)) {
    return [];
  }
  const fields = new Set<EventTextField>();
  for (const location of failure.detail) {
    if (typeof location !== "object" || location === null) {
      continue;
    }
    const field: unknown = (location as { field?: unknown }).field;
    if (typeof field === "string" && EVENT_TEXT_FIELDS.includes(field)) {
      fields.add(field as EventTextField);
    }
  }
  return [...fields];
}

/**
 * The dates an `occurrence-in-use` refusal named.
 *
 * "YYYY-MM-DD" on the association's own clock, and the association's own
 * calendar rather than anybody's data: the refusal says which dates people are
 * standing on and never which people, so the board can call those dates off or
 * stand their sign-ups down and try the edit again.
 *
 * Narrowed rather than trusted, because `ApiFailure.detail` is `unknown` and
 * endpoint-specific. Anything that is not a date in that form is dropped: the
 * screen renders these into a sentence, and a value of another shape would put
 * whatever it held onto the screen.
 */
export function refusedDates(failure: ApiFailure): readonly string[] {
  if (!Array.isArray(failure.detail)) {
    return [];
  }
  return failure.detail.filter(
    (entry): entry is string =>
      typeof entry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry),
  );
}

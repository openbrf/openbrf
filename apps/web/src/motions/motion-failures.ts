import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the motion screen can meet, in one sentence each.
 *
 * The 403 branch is in {@link failureMessageKey} and covers the guard refusing an
 * account that does not hold the capability. `not-a-member` is also a 403 and is
 * therefore mapped here explicitly - and it has to be, because the shared
 * sentence ("your account is not allowed to change this") would be the wrong
 * thing to tell somebody: they are not being told about a permission somebody
 * could grant them, they are being told what the statute says about who may put
 * an item to a general meeting.
 *
 * The refusals reachable only from the settings panel are deliberately absent.
 * A board member configuring the bylaws clause is told about a month and a day
 * that no year has in the panel's own words, which are not the words to use to a
 * member writing a motion.
 */

/**
 * The reasons the motions module refuses with.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client, and written out in full rather than left as `string`:
 * the map below is checked against it with `satisfies`, so a reason the server
 * gains and this client has no sentence for is a compile error here rather than
 * "something went wrong" on a board member's screen.
 *
 * That check is what a map typed only as `Record<string, TranslationKey>` does
 * not give. Such a map compiles with a reason missing and falls through to the
 * unknown sentence at runtime, which is a defect nothing surfaces until somebody
 * meets it.
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

const MOTION_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "not-a-member": "motions.errors.notAMember",
  "motion-not-found": "motions.errors.motionNotFound",
  "already-closed": "motions.errors.alreadyClosed",
  /*
   * An item the member took back, which is not the same as one the board has
   * closed. It refuses being put to a meeting for a reason that is the member's
   * decision rather than a state the board can move it out of, so the sentence
   * says so instead of inviting another attempt.
   */
  "motion-withdrawn": "motions.errors.motionWithdrawn",
  /*
   * The three refusals the meeting link meets. Separate sentences because the
   * board's next act differs in each: a meeting that is gone means reading the
   * list again, one already held means choosing another, and one whose notice
   * has gone out cannot take the item at all - EFL 6 kap. 25 § leaves a meeting
   * unable to decide a matter its notice did not take up, so attaching an item
   * afterwards would claim it could.
   */
  "meeting-not-found": "motions.errors.meetingNotFound",
  "meeting-already-held": "motions.errors.meetingAlreadyHeld",
  "meeting-notice-issued": "motions.errors.meetingNoticeIssued",
  /*
   * Deliberately not folded into the sentence above it. The board loses this
   * one to another board member who moved the same item, and the motion is
   * exactly as open as it was - "no longer open" would send somebody looking
   * for a state it is not in, when what they have to do is read the queue
   * again.
   */
  "meeting-changed-meanwhile": "motions.errors.meetingChangedMeanwhile",
  "personal-identity-number": "motions.errors.personalIdentityNumber",
  "invalid-body": "motions.errors.invalidBody",
} satisfies Record<MotionReason | "invalid-body", TranslationKey>;

/**
 * The sentence for a refusal from this module.
 *
 * `not-a-member` is resolved before the shared 403 branch, which is the whole
 * reason this wrapper exists rather than the map being passed straight to
 * {@link failureMessageKey}: the shared branch answers every 403 with one
 * sentence, and this one refusal needs its own.
 */
export function motionFailureKey(failure: ApiFailure): TranslationKey {
  const own = MOTION_FAILURES[failure.reason];
  if (own !== undefined) {
    return own;
  }
  return failureMessageKey(failure, MOTION_FAILURES, "motions.errors.unknown");
}

/**
 * The parts of a motion a refusal can name.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client. Narrower than `string` on purpose: see
 * {@link scannedParts}.
 */
export type MotionPart = "title" | "body";

const MOTION_PARTS: readonly string[] = ["title", "body"];

/**
 * Which parts of a motion carried a personal identity number.
 *
 * Read off the refusal's `locations`, which carry a field name and an offset and
 * never the value that was found. Only the field names are used here: telling a
 * member "there is a personal identity number in the body" is actionable, and
 * quoting the number back at them on the screen would be the disclosure the scan
 * exists to prevent.
 *
 * A name this client does not know is dropped rather than carried through. The
 * screen has one sentence per part and no honest way to render a third, so an
 * unrecognised name would be folded into one of the two it does have - and
 * pointing a member at the wrong field sends them editing text that holds
 * nothing, which leaves the personal identity number where it is and the motion
 * refused again. Saying less than the response did is the direction to fail in.
 */
export function scannedParts(failure: ApiFailure): readonly MotionPart[] {
  if (!Array.isArray(failure.detail)) {
    return [];
  }
  const parts = new Set<MotionPart>();
  for (const location of failure.detail) {
    if (typeof location !== "object" || location === null) {
      continue;
    }
    const part: unknown = (location as { part?: unknown }).part;
    if (typeof part === "string" && MOTION_PARTS.includes(part)) {
      parts.add(part as MotionPart);
    }
  }
  return [...parts];
}

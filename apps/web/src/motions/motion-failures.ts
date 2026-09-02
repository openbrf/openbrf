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
const MOTION_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "not-a-member": "motions.errors.notAMember",
  "motion-not-found": "motions.errors.motionNotFound",
  "already-closed": "motions.errors.alreadyClosed",
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
};

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

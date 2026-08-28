import type { TranslationKey } from "../i18n/translation-key";
import type { MoveErrorReason } from "./moves-api";

/**
 * The API's machine-readable reason, turned into a key this interface owns.
 *
 * The API answers in English while the interface is Swedish by default, and how
 * much a failure explains is a decision for the screen rather than a
 * translation. Anything unrecognised falls back to the general message rather
 * than rendering a code at a board member.
 *
 * Keyed on the reason union rather than on `string`, so a reason added to the
 * API and not given a message here fails the build instead of reaching a board
 * member as the general fallback. The lookup below still takes a `string`,
 * because the wire value is whatever the server sent and no type checks that.
 */
const MESSAGES: Record<MoveErrorReason, TranslationKey> = {
  "person-not-found": "moves.errors.personNotFound",
  "apartment-not-found": "moves.errors.apartmentNotFound",
  "residency-not-found": "moves.errors.residencyNotFound",
  "already-resident": "moves.errors.alreadyResident",
  "already-moved-out": "moves.errors.alreadyMovedOut",
  "moved-out-before-moved-in": "moves.errors.movedOutBeforeMovedIn",
  "transfer-person-not-found": "moves.errors.transferPersonNotFound",
  "transfer-reference-required": "moves.errors.transferReferenceRequired",
};

export function failureMessage(reason: string): TranslationKey {
  return MESSAGES[reason as MoveErrorReason] ?? "moves.errors.unknown";
}

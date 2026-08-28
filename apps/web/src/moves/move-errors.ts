import type { TranslationKey } from "../i18n/translation-key";

/**
 * The API's machine-readable reason, turned into a key this interface owns.
 *
 * The API answers in English while the interface is Swedish by default, and how
 * much a failure explains is a decision for the screen rather than a
 * translation. Anything unrecognised falls back to the general message rather
 * than rendering a code at a board member.
 */
const MESSAGES: Record<string, TranslationKey> = {
  "person-not-found": "moves.errors.personNotFound",
  "apartment-not-found": "moves.errors.apartmentNotFound",
  "residency-not-found": "moves.errors.residencyNotFound",
  "already-resident": "moves.errors.alreadyResident",
  "already-moved-out": "moves.errors.alreadyMovedOut",
  "moved-out-before-moved-in": "moves.errors.movedOutBeforeMovedIn",
  "transfer-person-not-found": "moves.errors.transferPersonNotFound",
};

export function failureMessage(reason: string): TranslationKey {
  return MESSAGES[reason] ?? "moves.errors.unknown";
}

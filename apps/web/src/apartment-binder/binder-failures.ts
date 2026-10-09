import type {
  ApartmentBinderReason,
  ApartmentBinderTextPart,
  MediaReason,
} from "@openbrf/shared";

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the apartment binder can answer with, in one sentence each.
 *
 * The unions are the ones the API throws with, so the map below, checked
 * against them with `satisfies`, makes a reason the server gains and this
 * client has no sentence for a compile error here rather than "something went
 * wrong" on somebody's screen.
 *
 * The media reasons are here as well, because filing an entry is an upload:
 * what the server refuses about the file arrives on the same call as what it
 * refuses about the entry, and a screen with a sentence for only half of them
 * would answer the other half with the shrug at the end. Three of them cannot
 * reach this screen: a filing is a PDF, so no declaration about the persons in
 * an image is asked for; `not-found` is the binder's own, with the same
 * sentence; and `forbidden` is a 403, answered before the map is read.
 */
type BinderReason =
  | ApartmentBinderReason
  | Exclude<MediaReason, "declaration-required" | "not-found" | "forbidden">;

const BINDER_FAILURES: Readonly<Record<string, TranslationKey>> = {
  /*
   * An apartment that is not there, one that is not this account's, and an
   * entry that is not theirs to take out. The server answers all three the same
   * way on purpose - a distinguishable answer would confirm which apartments
   * exist and who lives in them - so this sentence says what the reader can act
   * on rather than which of them it was.
   */
  "not-found": "apartmentBinder.errors.notFound",
  "kind-is-the-boards": "apartmentBinder.errors.kindIsTheBoards",
  "date-required": "apartmentBinder.errors.dateRequired",
  "personal-identity-number": "apartmentBinder.errors.personalIdentityNumber",
  "binder-full": "apartmentBinder.errors.binderFull",
  "no-file": "apartmentBinder.errors.noFile",
  "empty-file": "apartmentBinder.errors.emptyFile",
  "too-large": "apartmentBinder.errors.tooLarge",
  "unsupported-type": "apartmentBinder.errors.unsupportedType",
  "invalid-body": "apartmentBinder.errors.invalidBody",
} satisfies Record<BinderReason | "invalid-body", TranslationKey>;

/** The sentence for a refusal from this module. */
export function binderFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(
    failure,
    BINDER_FAILURES,
    "apartmentBinder.errors.unknown",
  );
}

/**
 * The parts of a filing a refusal can name.
 *
 * Narrower than `string` on purpose: see {@link scannedBinderParts}.
 */
const BINDER_PARTS: readonly string[] = [
  "title",
  "fileName",
] satisfies readonly ApartmentBinderTextPart[];

/** The sentence that says which of the two carried the number. */
export const PART_SENTENCE: Readonly<
  Record<ApartmentBinderTextPart, TranslationKey>
> = {
  title: "apartmentBinder.errors.scannedTitle",
  fileName: "apartmentBinder.errors.scannedFileName",
};

/**
 * Which parts of a filing carried a personal identity number.
 *
 * Read off the refusal's `locations`, which carry a field name and an offset
 * and never the value that was found. Only the field names are used here:
 * telling somebody "there is a personal identity number in what you wrote" is
 * actionable, and quoting the number back at them on the screen would be the
 * disclosure the scan exists to prevent.
 *
 * Which of the two it was has to be said, because the two are fixed in
 * different places. A title is retyped in the field above; a file name is
 * changed on the reader's own computer and the file chosen again - and a person
 * told only that "the filing" carries a number will retype the title, be
 * refused again, and have learnt nothing. The server answers the field for
 * exactly that reason, and a screen that drops it throws away the one part of
 * the refusal somebody can act on.
 *
 * Both, where both carried one. A name this client does not know is dropped
 * rather than carried through, on the key orders' rule: pointing somebody at a
 * field that holds nothing leaves the number where it is and the entry refused
 * again.
 */
export function scannedBinderParts(
  failure: ApiFailure,
): readonly ApartmentBinderTextPart[] {
  if (!Array.isArray(failure.detail)) {
    return [];
  }
  const parts = new Set<ApartmentBinderTextPart>();
  for (const location of failure.detail) {
    if (typeof location !== "object" || location === null) {
      continue;
    }
    const part: unknown = (location as { part?: unknown }).part;
    if (typeof part === "string" && BINDER_PARTS.includes(part)) {
      parts.add(part as ApartmentBinderTextPart);
    }
  }
  // In the order the form reads, rather than in the order the scan found them:
  // the title is the field above the file on the panel.
  return BINDER_PARTS.filter((part) =>
    parts.has(part as ApartmentBinderTextPart),
  ) as ApartmentBinderTextPart[];
}

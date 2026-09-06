import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the subletting screen can meet, in one sentence each.
 *
 * The 403 branch is in {@link failureMessageKey} and covers the guard refusing
 * an account that does not hold the capability. `not-a-member` is also a 403 and
 * is therefore mapped here explicitly - and it has to be, because the shared
 * sentence ("your account is not allowed to change this") would be the wrong
 * thing to tell somebody: they are not being told about a permission somebody
 * could grant them, they are being told what BRL 7 kap. 10 § says about who may
 * let an apartment in andra hand.
 */

/**
 * The reasons the sublets module refuses with.
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
export type SubletReason =
  | "not-a-member"
  | "apartment-not-found"
  | "application-not-found"
  | "already-closed"
  | "not-refused"
  | "invalid-period"
  | "personal-identity-number";

const SUBLET_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "not-a-member": "sublets.errors.notAMember",
  /*
   * An apartment the caller does not hold, and one that is not in the register
   * at all. The server answers both the same way on purpose - a distinguishable
   * answer would let the form enumerate the building - so this sentence says
   * what the caller can act on rather than which of the two it was.
   */
  "apartment-not-found": "sublets.errors.apartmentNotFound",
  "application-not-found": "sublets.errors.applicationNotFound",
  "already-closed": "sublets.errors.alreadyClosed",
  /*
   * A rent tribunal permission recorded against an application the board did
   * not refuse. BRL 7 kap. 11 § opens that route only from a refusal, so the
   * sentence says which state it needs rather than inviting another attempt.
   */
  "not-refused": "sublets.errors.notRefused",
  "invalid-period": "sublets.errors.invalidPeriod",
  "personal-identity-number": "sublets.errors.personalIdentityNumber",
  "invalid-body": "sublets.errors.invalidBody",
} satisfies Record<SubletReason | "invalid-body", TranslationKey>;

/**
 * The sentence for a refusal from this module.
 *
 * `not-a-member` is resolved before the shared 403 branch, which is the whole
 * reason this wrapper exists rather than the map being passed straight to
 * {@link failureMessageKey}: the shared branch answers every 403 with one
 * sentence, and this one refusal needs its own.
 */
export function subletFailureKey(failure: ApiFailure): TranslationKey {
  const own = SUBLET_FAILURES[failure.reason];
  if (own !== undefined) {
    return own;
  }
  return failureMessageKey(failure, SUBLET_FAILURES, "sublets.errors.unknown");
}

/**
 * The parts of an application a refusal can name.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client. Narrower than `string` on purpose: see
 * {@link scannedSubletParts}.
 */
export type SubletPart = "reason" | "decisionNote";

const SUBLET_PARTS: readonly string[] = ["reason", "decisionNote"];

/**
 * Which parts of an application carried a personal identity number.
 *
 * Read off the refusal's `locations`, which carry a field name and an offset and
 * never the value that was found. Only the field names are used here: telling
 * somebody "there is a personal identity number in the reason" is actionable,
 * and quoting the number back at them on the screen would be the disclosure the
 * scan exists to prevent.
 *
 * A name this client does not know is dropped rather than carried through. The
 * screen has one sentence per part and no honest way to render a third, so an
 * unrecognised name would be folded into one of the two it does have - and
 * pointing somebody at the wrong field sends them editing text that holds
 * nothing, which leaves the personal identity number where it is and the
 * application refused again. Saying less than the response did is the direction
 * to fail in.
 */
export function scannedSubletParts(failure: ApiFailure): readonly SubletPart[] {
  if (!Array.isArray(failure.detail)) {
    return [];
  }
  const parts = new Set<SubletPart>();
  for (const location of failure.detail) {
    if (typeof location !== "object" || location === null) {
      continue;
    }
    const part: unknown = (location as { part?: unknown }).part;
    if (typeof part === "string" && SUBLET_PARTS.includes(part)) {
      parts.add(part as SubletPart);
    }
  }
  return [...parts];
}

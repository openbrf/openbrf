import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the key order screen can meet, in one sentence each.
 *
 * There is deliberately no entry answering a 403 of its own, which is the
 * difference from `sublet-failures.ts` beside it. Nothing statutory decides who
 * may ask the association for a key, so there is no statement of law to make and
 * the shared sentence about a capability is exactly right: whoever meets it is
 * being told about a grant somebody could give them.
 */

/**
 * The reasons the key orders module refuses with.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client, and written out in full rather than left as `string`:
 * the map below is checked against it with `satisfies`, so a reason the server
 * gains and this client has no sentence for is a compile error here rather than
 * "something went wrong" on a board member's screen.
 */
export type KeyOrderReason =
  | "apartment-not-found"
  | "order-not-found"
  | "already-closed"
  | "personal-identity-number";

const KEY_ORDER_FAILURES: Readonly<Record<string, TranslationKey>> = {
  /*
   * An apartment the caller does not live in, and one that is not in the
   * register at all. The server answers both the same way on purpose - a
   * distinguishable answer would let the form enumerate the building - so this
   * sentence says what the caller can act on rather than which of the two it
   * was.
   */
  "apartment-not-found": "keyOrders.errors.apartmentNotFound",
  "order-not-found": "keyOrders.errors.orderNotFound",
  "already-closed": "keyOrders.errors.alreadyClosed",
  "personal-identity-number": "keyOrders.errors.personalIdentityNumber",
  "invalid-body": "keyOrders.errors.invalidBody",
} satisfies Record<KeyOrderReason | "invalid-body", TranslationKey>;

/** The sentence for a refusal from this module. */
export function keyOrderFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(
    failure,
    KEY_ORDER_FAILURES,
    "keyOrders.errors.unknown",
  );
}

/**
 * The parts of an order a refusal can name.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client. Narrower than `string` on purpose: see
 * {@link scannedKeyOrderParts}.
 */
export type KeyOrderPart = "note" | "boardNote";

const KEY_ORDER_PARTS: readonly string[] = ["note", "boardNote"];

/**
 * Which parts of an order carried a personal identity number.
 *
 * Read off the refusal's `locations`, which carry a field name and an offset and
 * never the value that was found. Only the field names are used here: telling
 * somebody "there is a personal identity number in what you wrote" is
 * actionable, and quoting the number back at them on the screen would be the
 * disclosure the scan exists to prevent.
 *
 * A name this client does not know is dropped rather than carried through, for
 * the reason `sublet-failures.ts` gives: pointing somebody at the wrong field
 * sends them editing text that holds nothing, which leaves the personal identity
 * number where it is and the order refused again.
 */
export function scannedKeyOrderParts(
  failure: ApiFailure,
): readonly KeyOrderPart[] {
  if (!Array.isArray(failure.detail)) {
    return [];
  }
  const parts = new Set<KeyOrderPart>();
  for (const location of failure.detail) {
    if (typeof location !== "object" || location === null) {
      continue;
    }
    const part: unknown = (location as { part?: unknown }).part;
    if (typeof part === "string" && KEY_ORDER_PARTS.includes(part)) {
      parts.add(part as KeyOrderPart);
    }
  }
  return [...parts];
}

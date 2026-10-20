import type { PendingChangeReason } from "@openbrf/shared";

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import type { PendingChange } from "./pending-changes-api";

/** The queue's own refusals, checked against the union the API throws with. */
const PENDING_CHANGE_FAILURES = {
  "pending-change-not-found": "pendingChanges.errors.notFound",
} as const satisfies Record<PendingChangeReason, TranslationKey>;

/**
 * The sentence for a refusal met while confirming or rejecting a change.
 *
 * Three sources, in order. The queue's own refusal says the change is not
 * waiting any more. A refusal about the person - they no longer hold what the
 * action needs - says so and that the change is still there to reject. And a
 * refusal the held action raised is the action's own, which it published with
 * the sentence the board's screens already show (`errors` on the action, see
 * docs/actions.md, "Refusals"); that sentence is used when this screen has it,
 * and a general one when it does not - a plugin's, whose translations are not
 * loaded here.
 *
 * Returned as a key the caller hands to `t`, with `exists` deciding whether the
 * action's own key can be used at all.
 */
export function pendingChangeFailureKey(
  failure: ApiFailure,
  change: PendingChange,
  exists: (key: string) => boolean,
): TranslationKey {
  const own = (PENDING_CHANGE_FAILURES as Record<string, TranslationKey>)[
    failure.reason
  ];
  if (own !== undefined) {
    return own;
  }
  if (failure.status === 403) {
    return "pendingChanges.errors.forbidden";
  }
  const published = change.action?.errors.find(
    (spec) => spec.reason === failure.reason,
  );
  if (published !== undefined && exists(published.messageKey)) {
    // A key the platform's own screens use, checked to exist just above.
    return published.messageKey as TranslationKey;
  }
  if (failure.status >= 400 && failure.status < 500) {
    return "pendingChanges.errors.refused";
  }
  return "pendingChanges.errors.unknown";
}

import type { PendingChangeReason } from "@openbrf/shared";

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import type { PendingChange } from "./pending-changes-api";

/**
 * The queue's own answers, checked against the union the API throws with.
 * Neither leaves the change waiting: one is not there to act on, and the other
 * was handed to its action and may have been carried out.
 */
const PENDING_CHANGE_FAILURES = {
  "pending-change-not-found": "pendingChanges.errors.notFound",
  "pending-change-failed-after-dispatch":
    "pendingChanges.errors.failedAfterDispatch",
} as const satisfies Record<PendingChangeReason, TranslationKey>;

/** What the screen says about a failed confirmation or rejection, and where. */
export interface PendingChangeFailure {
  /** The sentence, as a key the caller hands to `t`. */
  readonly key: TranslationKey;
  /**
   * Whether the change is known to be waiting still: a refusal, which wrote
   * nothing. The sentence then sits on the change, which can be confirmed
   * again or rejected. Otherwise the change has ended, or what became of it
   * is not known, so the screen reads the queue again and says it above the
   * list, where it outlasts the change.
   */
  readonly waiting: boolean;
}

/**
 * What to say about a failure met while confirming or rejecting a change.
 *
 * The queue's own answers say the change is not waiting any more: it was not
 * there, or it was handed to its action and something failed after that, so
 * its write may stand. A refusal about the person - they no longer hold what
 * the action needs - says so and that the change is still there to reject. A
 * refusal the held action raised is the action's own, which it published with
 * the sentence the board's screens already show (`errors` on the action, see
 * docs/actions.md, "Refusals"); that sentence is used when this screen has it,
 * and a general one when it does not - a plugin's, whose translations are not
 * loaded here. Anything else - a server error, or no answer at all - says
 * that what became of the change is not known, and tells the person to check.
 * The queue read again does not settle it: an answer lost on the way back may
 * belong to a confirmation still in the registry's checks, which claims and
 * runs the change after that read has listed it (ADR 0039). A second press is
 * safe all the same, since only one confirmation can claim a change.
 *
 * `kind` is which answer the person gave, so the sentence names it.
 * `exists` decides whether the action's own key can be used at all.
 */
export function pendingChangeFailure(
  failure: ApiFailure,
  change: PendingChange,
  kind: "confirm" | "reject",
  exists: (key: string) => boolean,
): PendingChangeFailure {
  const own = (PENDING_CHANGE_FAILURES as Record<string, TranslationKey>)[
    failure.reason
  ];
  if (own !== undefined) {
    return { key: own, waiting: false };
  }
  if (failure.status === 403) {
    return { key: "pendingChanges.errors.forbidden", waiting: true };
  }
  const published = change.action?.errors.find(
    (spec) => spec.reason === failure.reason,
  );
  if (published !== undefined && exists(published.messageKey)) {
    // A key the platform's own screens use, checked to exist just above.
    return { key: published.messageKey as TranslationKey, waiting: true };
  }
  if (failure.status >= 400 && failure.status < 500) {
    return { key: "pendingChanges.errors.refused", waiting: true };
  }
  return {
    key:
      kind === "confirm"
        ? "pendingChanges.errors.unknown"
        : "pendingChanges.errors.rejectUnknown",
    waiting: false,
  };
}

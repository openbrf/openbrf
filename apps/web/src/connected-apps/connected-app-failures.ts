import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal a connected-app surface can meet, in one sentence each.
 *
 * The API answers with a code rather than a sentence, because the interface is
 * Swedish and the server's messages are English, and how much a refusal
 * explains is a decision for the screen. A code is never printed: an unmapped
 * one becomes the surface's generic sentence, so a reason this build has not
 * heard of reads as "it did not work" rather than as machine text.
 *
 * Held in one module rather than in each panel because the member's own
 * section and the instance-wide screen meet the same refusals for the same
 * reasons, and a copy of the map per panel would drift into two sentences for
 * one fact.
 */

/**
 * The disconnect refusals, and the sentence each becomes.
 *
 * Typed as an open record rather than as a closed union: the API may answer
 * with a reason this build has not heard of, and the fallback below is what
 * such a code becomes.
 */
const DISCONNECT_FAILURES: Readonly<Record<string, TranslationKey>> = {
  // The connection is already gone - cut in another tab, or by the board while
  // the member was looking at it. Reading the list again is the way out, and
  // the sentence says so.
  "not-found": "connectedApps.errors.notFound",
  // Cutting somebody else's connection is dataProtection:manage. Named
  // separately from the shared permission sentence because it is about acting
  // on another person's data rather than about this screen being off limits.
  "forbidden-capability": "connectedApps.errors.forbidden",
};

/**
 * The registration refusals.
 *
 * `invalid-body` is the endpoint's own schema refusal rather than a domain
 * reason, and on this form it can only be about the addresses: the name field
 * is bounded to the same length the endpoint accepts, so nothing else the form
 * can send is capable of failing that check.
 */
const REGISTER_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "invalid-redirect-uri": "connectedApps.register.errors.invalidRedirectUri",
  "invalid-body": "connectedApps.register.errors.invalidRedirectUri",
  "name-taken": "connectedApps.register.errors.nameTaken",
  // The instance advertises no address for connected apps to sign in to, so
  // the client has nothing to be bound to. The fix is an install, not a retry.
  "resource-missing": "connectedApps.register.errors.resourceMissing",
};

/**
 * The sentence for a failed disconnect.
 *
 * This module's own reasons are resolved before the shared branches, so
 * `forbidden-capability` keeps its own sentence rather than becoming the
 * general one about permissions.
 *
 * The status branch is what carries a plain 404: the route answers a missing
 * connection with a not-found that has no code of its own, so the status is
 * the only thing that names it.
 */
export function disconnectFailureKey(failure: ApiFailure): TranslationKey {
  const own = DISCONNECT_FAILURES[failure.reason];
  if (own !== undefined) {
    return own;
  }
  if (failure.status === 404) {
    return "connectedApps.errors.notFound";
  }
  return failureMessageKey(
    failure,
    DISCONNECT_FAILURES,
    "connectedApps.errors.failed",
  );
}

/** The sentence for a refused registration. */
export function registerClientFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(
    failure,
    REGISTER_FAILURES,
    "connectedApps.register.errors.failed",
  );
}

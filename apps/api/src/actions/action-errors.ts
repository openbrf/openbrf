import type { ActionErrorSpec } from "@openbrf/plugin-sdk";

/**
 * What each service's refusals mean to a caller, published with the action.
 *
 * A caller here is often a model rather than a person, and the two need
 * different things from a refusal. A person reads a sentence and decides; a
 * model needs to know whether trying again could work and what to change first,
 * because without that it will either give up on something it could have fixed
 * or retry something that can never succeed. So every refusal an action's
 * handler can raise travels with the action, carrying a verdict.
 *
 * The three verdicts, and what separates them:
 *
 *   `after-edit` - the request was wrong and a different one would work. A
 *   taken address, a body holding something a news item may not hold, a stale
 *   revision. The caller changes the input and calls again.
 *
 *   `never` - nothing the caller can send will change the answer, because what
 *   stands in the way is a fact about the association rather than about the
 *   request. A mailing that has gone out, a photograph consent only a board
 *   member may confirm. Retrying is noise, and telling a person is the useful
 *   next step.
 *
 *   `after-backoff` - the answer may change on its own. Nothing in the first
 *   slice raises one; it is here because read-only mode and the rate limiter
 *   do, and a connector needs one vocabulary for all of them.
 *
 * The sentences are the ones the board's own screens already show, by key. A
 * second set written for callers would be a second thing to keep true, and the
 * first time they disagreed a person and a model would be told different
 * stories about the same refusal.
 */

function spec(
  reason: string,
  retry: ActionErrorSpec["retry"],
  messageKey: string,
): ActionErrorSpec {
  return { reason, retry, messageKey };
}

/** Every refusal `PagesWriteService` raises, as `PageWriteReason` declares them. */
export const PAGE_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec("not-found", "never", "siteAdmin.errors.pageGone"),
  spec("invalid-slug", "after-edit", "siteAdmin.errors.invalidSlug"),
  spec("slug-taken", "after-edit", "siteAdmin.errors.slugTaken"),
  // Somebody else saved while this caller was holding a copy. Reading the page
  // again and reapplying the change is exactly what a person does here.
  spec("page-changed", "after-edit", "siteAdmin.errors.pageChanged"),
  spec(
    "personal-identity-number",
    "after-edit",
    "siteAdmin.errors.personalIdentityNumber",
  ),
  /*
   * The one refusal in this list that a caller must never try to satisfy. The
   * confirmation is the board declaring that the photograph consents exist -
   * an attestation under GDPR - so it is not an input an action may supply,
   * and the only way past it is a board member confirming in the web
   * interface.
   */
  spec(
    "photo-consent-required",
    "never",
    "siteAdmin.errors.photoConsentRequired",
  ),
  spec("image-not-found", "never", "siteAdmin.errors.imageNotFound"),
  spec("image-not-public", "never", "siteAdmin.errors.imageNotPublic"),
];

/** Every refusal `NewsWriteService` raises, as `NewsWriteReason` declares them. */
export const NEWS_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec("not-found", "never", "news.errors.notFound"),
  spec("invalid-slug", "after-edit", "news.errors.invalidSlug"),
  spec("slug-taken", "after-edit", "news.errors.slugTaken"),
  // The address was in what went out to the members, so it is now part of a
  // thing that cannot be recalled.
  spec("address-mailed", "never", "news.errors.addressMailed"),
  // And the mailing this item was asked for has already gone.
  spec("already-mailed", "never", "news.errors.addressMailed"),
  spec(
    "personal-identity-number",
    "after-edit",
    "news.errors.personalIdentityNumber",
  ),
  spec("unsupported-block", "after-edit", "news.errors.unsupportedBlock"),
];

/** Every refusal `MenuWriteService` raises, as `MenuWriteReason` declares them. */
export const MENU_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec("not-found", "never", "siteAdmin.menu.errors.notFound"),
  spec(
    "parent-not-found",
    "after-edit",
    "siteAdmin.menu.errors.parentNotFound",
  ),
  spec("page-not-found", "after-edit", "siteAdmin.menu.errors.pageNotFound"),
  spec(
    "unknown-generated-key",
    "after-edit",
    "siteAdmin.menu.errors.unknownGeneratedKey",
  ),
  spec("invalid-url", "after-edit", "siteAdmin.menu.errors.invalidUrl"),
  spec("label-required", "after-edit", "siteAdmin.menu.errors.labelRequired"),
  spec("label-too-long", "after-edit", "siteAdmin.menu.errors.labelTooLong"),
  spec("target-required", "after-edit", "siteAdmin.menu.errors.targetRequired"),
  // The menu is two levels deep because a third needs a script to open and the
  // website runs none. No input makes a third level possible.
  spec("nesting-too-deep", "never", "siteAdmin.menu.errors.nestingTooDeep"),
];

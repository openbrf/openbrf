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
  // Choosing another front page first, which page_set_front_page does, is
  // what a person does here.
  spec("front-page", "after-edit", "siteAdmin.errors.frontPage"),
  spec(
    "front-page-not-public",
    "after-edit",
    "siteAdmin.errors.frontPageNotPublic",
  ),
  // What stands on a built-in page is the product's, and it stays public and
  // stays put. Nothing a caller sends gives it a body, another address or
  // another status; its title is all there is to write.
  spec("built-in", "never", "siteAdmin.errors.builtIn"),
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
  // Somebody else saved while this caller was holding a copy, as for a page.
  spec("news-changed", "after-edit", "news.errors.newsChanged"),
  // Comments stand under the item. Nothing the caller sends removes them: they
  // go on the feed purge's clock, and taking the item down is what is left to
  // do.
  spec("has-comments", "never", "news.errors.hasComments"),
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
  spec("invalid-url", "after-edit", "siteAdmin.menu.errors.invalidUrl"),
  spec("label-required", "after-edit", "siteAdmin.menu.errors.labelRequired"),
  spec("label-too-long", "after-edit", "siteAdmin.menu.errors.labelTooLong"),
  spec("target-required", "after-edit", "siteAdmin.menu.errors.targetRequired"),
  // The menu is two levels deep because a third needs a script to open and the
  // website runs none. No input makes a third level possible.
  spec("nesting-too-deep", "never", "siteAdmin.menu.errors.nestingTooDeep"),
  // Another caller added, removed or arranged an entry after this one read the
  // menu; reading it again gives the arrangement to start from.
  spec("menu-changed", "after-edit", "siteAdmin.menu.errors.menuChanged"),
];

/**
 * Every refusal `AssociationFactsService` raises, as `AssociationFactsReason`
 * declares them.
 *
 * One, and the list exists anyway: an action publishes what its handler can
 * raise, and an empty list would tell a caller the save cannot be refused. The
 * refusal names the field and the offset and never the number, so a caller
 * acting on it edits the field the answer names rather than guessing.
 */
export const FACTS_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec(
    "personal-identity-number",
    "after-edit",
    "siteAdmin.errors.personalIdentityNumber",
  ),
];

/**
 * Every refusal `NewsCommentService` raises, as `NewsCommentReason` declares
 * them.
 *
 * It carries the product's first `after-backoff`. `too-many-comments` answers
 * 429 and is genuinely time-bounded - twenty comments per ten minutes per
 * author, one budget across the feed and the news screen, since a comment on a
 * news item is a comment on its post (ADR 0026) - so the answer changes on its
 * own with nothing the caller can send,
 * which is precisely what separates that verdict from the other two. A model
 * told `never` would give up on a thread it could have written to a minute
 * later, and one told `after-edit` would rewrite a comment that was never the
 * problem.
 */
export const NEWS_COMMENT_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec("news-not-found", "never", "newsReader.errors.newsNotFound"),
  spec("comment-not-found", "never", "newsReader.errors.commentNotFound"),
  spec("comments-closed", "never", "newsReader.errors.commentsClosed"),
  spec(
    "personal-identity-number",
    "after-edit",
    "newsReader.errors.personalIdentityNumber",
  ),
  spec(
    "too-many-comments",
    "after-backoff",
    "newsReader.errors.tooManyComments",
  ),
];

/**
 * Every refusal `MotionService` raises, as `MotionReason` declares them.
 *
 * `meeting-notice-issued` is `never` and is the statutory one: EFL 6 kap. 25 §
 * leaves a general meeting unable to decide a matter its notice did not state,
 * so once the notice has gone out the agenda is settled and no input changes
 * that. `meeting-changed-meanwhile` is the opposite case - somebody else moved
 * the item while this caller held a copy - and re-reading the queue and
 * deciding again is exactly what a board member does there.
 */
export const MOTION_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec("motion-not-found", "never", "motions.errors.motionNotFound"),
  spec("not-a-member", "never", "motions.errors.notAMember"),
  spec("already-closed", "never", "motions.errors.alreadyClosed"),
  spec("motion-withdrawn", "never", "motions.errors.motionWithdrawn"),
  spec("meeting-not-found", "after-edit", "motions.errors.meetingNotFound"),
  spec("meeting-notice-issued", "never", "motions.errors.meetingNoticeIssued"),
  spec("meeting-already-held", "never", "motions.errors.meetingAlreadyHeld"),
  spec(
    "meeting-changed-meanwhile",
    "after-edit",
    "motions.errors.meetingChangedMeanwhile",
  ),
  spec(
    "personal-identity-number",
    "after-edit",
    "motions.errors.personalIdentityNumber",
  ),
];

/**
 * Every refusal the meeting reads can raise.
 *
 * One, because `MeetingService.outline` and `list` refuse nothing else: an id
 * that names no meeting. `after-edit`, as on the motions side, because reading
 * the list again and choosing a meeting that exists is what a board member does.
 */
export const MEETING_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec("meeting-not-found", "after-edit", "meetings.errors.meetingNotFound"),
];

/**
 * Every refusal writing a meeting's agenda can raise, as
 * `MeetingService.setAgenda` raises them.
 *
 * A notice that has been issued and a meeting recorded as held are `never`:
 * both are facts about the meeting that no input changes, and the remedy for a
 * notice that went wrong is an extra general meeting (EFL 6 kap. 25 §). An
 * agenda rewritten since it was read is `after-edit`: reading it again and
 * drafting anew is what works.
 */
export const MEETING_AGENDA_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  ...MEETING_ACTION_ERRORS,
  spec("agenda-changed", "after-edit", "meetings.errors.agendaChanged"),
  spec("notice-already-issued", "never", "meetings.errors.noticeAlreadyIssued"),
  spec("meeting-already-held", "never", "meetings.errors.meetingAlreadyHeld"),
];

/**
 * Every refusal the document reads can raise.
 *
 * `not-found` covers a document on a shelf the caller does not reach as well
 * as one that does not exist, so the refusal does not say which. A file the
 * parser cannot read, one too large to read and one locked with a password are
 * `never`: the same file gives the same answer. Running out of time is
 * `after-edit`, because fewer pages in one call is what reads the file, and
 * finding the instance busy reading others is `after-backoff`.
 */
export const DOCUMENT_ACTION_ERRORS: readonly ActionErrorSpec[] = [
  spec("not-found", "after-edit", "documents.errors.notFound"),
  spec("too-large-to-read", "never", "documents.errors.tooLargeToRead"),
  spec("unreadable", "never", "documents.errors.unreadable"),
  spec("password-protected", "never", "documents.errors.passwordProtected"),
  spec("read-timed-out", "after-edit", "documents.errors.readTimedOut"),
  // The instance's ceiling on reads running at once, which frees itself as
  // they finish.
  spec("read-busy", "after-backoff", "documents.errors.readBusy"),
];

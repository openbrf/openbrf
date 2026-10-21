import type { FeedReason, MediaReason } from "@openbrf/shared";

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the feed can meet, in one sentence each.
 *
 * The API answers with a code rather than prose, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * the screen's decision.
 *
 * Total over {@link FeedReason}, the union the API throws with, so a reason
 * added there without a sentence beside it fails the build rather than reaching
 * somebody as a code.
 *
 * `audience-not-found` is deliberately vaguer than what happened, and the screen
 * must not undo that in the wording. It answers an audience that does not exist
 * and one this person is not in, as one answer - anybody who could tell those
 * apart could walk the identifiers and learn what groups the association has,
 * and a group is invisible to somebody outside it only while that holds.
 * `post-not-found`, `comment-not-found` and `image-not-found` are vague in the
 * same way and for the same reason.
 *
 * `invalid-body` is not one of the module's own reasons - it is the endpoint's
 * schema refusing a body this form should not have been able to send, an empty
 * post or one past the cap - so it sits beside the union rather than inside it,
 * and the type keeps the totality where totality is worth having.
 *
 * A 403 is answered before this map is consulted at all, by the shared branch in
 * {@link failureMessageKey}. That is somebody who holds no capability, and the
 * sentence it reaches is the general one about an account not being allowed a
 * screen. Somebody holding the capability and no audience is a different case
 * entirely and is not a refusal: they are answered with no audiences, and the
 * screen says why.
 */
const FEED_FAILURES = {
  "audience-not-found": "feed.errors.audienceNotFound",
  "post-not-found": "feed.errors.postNotFound",
  "comment-not-found": "feed.errors.commentNotFound",
  "report-not-found": "feed.errors.reportNotFound",
  "report-resolved": "feed.errors.reportResolved",
  "not-a-resident": "feed.errors.notAResident",
  "not-reportable": "feed.errors.notReportable",
  "already-reported": "feed.errors.alreadyReported",
  "too-many-groups": "feed.errors.tooManyGroups",
  "group-full": "feed.errors.groupFull",
  "comments-closed": "feed.errors.commentsClosed",
  "post-erased": "feed.errors.postErased",
  "personal-identity-number": "feed.errors.personalIdentityNumber",
  "too-many-posts": "feed.errors.tooManyPosts",
  "too-many-comments": "feed.errors.tooManyComments",
  "image-not-found": "feed.errors.imageNotFound",
  "too-many-images": "feed.errors.tooManyImages",
  "too-many-uploads": "feed.errors.tooManyUploads",
  "not-board": "feed.errors.notBoard",
  "board-post-audience": "feed.errors.boardPostAudience",
  "schedule-out-of-range": "feed.errors.scheduleOutOfRange",
  "not-pinnable": "feed.errors.notPinnable",
  "not-editable": "feed.errors.notEditable",
  "too-many-edits": "feed.errors.tooManyEdits",
  "history-withheld": "feed.errors.historyWithheld",
  "not-important": "feed.errors.notImportant",
  "not-scheduled": "feed.errors.notScheduled",
  "not-strikeable": "feed.errors.notStrikeable",
  "invalid-body": "feed.errors.invalidBody",
} as const satisfies Record<FeedReason | "invalid-body", TranslationKey>;

/**
 * The refusals of an image upload, which the media layer answers rather than
 * the feed: the file is identified from its own bytes and bounded as it
 * arrives, wherever it is uploaded from. `not-found` and `forbidden` are never
 * an upload's answer, and fall through to the feed's own sentences.
 */
const UPLOAD_FAILURES = {
  "no-file": "feed.errors.noFile",
  "empty-file": "feed.errors.emptyFile",
  "too-large": "feed.errors.imageTooLarge",
  "unsupported-type": "feed.errors.notAnImage",
  "declaration-required": "feed.errors.notAnImage",
} as const satisfies Partial<Record<MediaReason, TranslationKey>>;

/**
 * The sentence for a refusal from a feed endpoint.
 *
 * The refusal for a personal identity number carries positions - a field name
 * and a character offset - and none of them is rendered. The texts it can be
 * about, a post, a comment and the note on a report, are each one field on
 * their own form, so naming the field says nothing the sentence has not, and an
 * offset into a textarea is not something a person can act on. What is never
 * rendered is the value: the response does not carry it, and a screen a whole
 * house is reading is exactly where it must not appear.
 */
export function feedFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(failure, FEED_FAILURES, "feed.errors.unknown");
}

/** The same, for an image upload, whose refusals are the media layer's first. */
export function uploadFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(
    failure,
    { ...FEED_FAILURES, ...UPLOAD_FAILURES },
    "feed.errors.unknown",
  );
}

/**
 * The same, for the form that names a new group. A personal identity number
 * there is in the name rather than in a post, and the sentence says so.
 */
export function groupNameFailureKey(failure: ApiFailure): TranslationKey {
  return failure.reason === "personal-identity-number"
    ? "feed.errors.groupNamePersonalIdentityNumber"
    : feedFailureKey(failure);
}

/**
 * The sentence for a read that failed.
 *
 * The shared branch of {@link failureMessageKey} words a request that never
 * arrived as a save ("could not be saved"), which tells somebody opening the
 * feed that something they wrote was lost. A read has nothing to lose, so every
 * failure that is not one of the endpoint's own refusals says the feed could
 * not be read.
 */
export function feedReadFailureKey(failure: ApiFailure): TranslationKey {
  return failure.reason === "offline"
    ? "feed.errors.readFailed"
    : failureMessageKey(failure, FEED_FAILURES, "feed.errors.readFailed");
}

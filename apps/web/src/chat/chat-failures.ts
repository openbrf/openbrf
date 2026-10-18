import type { FeedReason } from "@openbrf/shared";

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal this screen can meet, in one sentence each.
 *
 * The API answers with a code rather than prose, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * the screen's decision.
 *
 * Total over {@link FeedReason}, the union the API throws with, so a reason
 * added there without a sentence beside it fails the build rather than reaching
 * a board member as a code. Some of them - the comment refusals - cannot be met
 * on this screen yet, which writes no comments; they have their sentences anyway,
 * because totality is what keeps the next one from being forgotten.
 *
 * `audience-not-found` is deliberately vaguer than what happened, and the screen
 * must not undo that in the wording. It answers an audience that does not exist
 * and one this person is not in, as one answer - anybody who could tell those
 * apart could walk the identifiers and learn what groups the association has,
 * and a group is invisible to somebody outside it only while that holds.
 * `post-not-found` and `comment-not-found` are vague in the same way and for the
 * same reason.
 *
 * `invalid-body` is not one of the module's own reasons - it is the endpoint's
 * schema refusing a body this form should not have been able to send, an empty
 * message or one past the cap - so it sits beside the union rather than inside
 * it, and the type keeps the totality where totality is worth having.
 *
 * A 403 is answered before this map is consulted at all, by the shared branch in
 * {@link failureMessageKey}. That is the resident who holds no seat and no
 * capability, and the sentence it reaches is the general one about an account
 * not being allowed a screen. The board member holding the capability and no
 * seat is a different case entirely and is not a refusal: they are answered with
 * no rooms, and the screen says why.
 */
const CHAT_FAILURES = {
  "audience-not-found": "chat.errors.audienceNotFound",
  "post-not-found": "chat.errors.postNotFound",
  "comment-not-found": "chat.errors.commentNotFound",
  "report-not-found": "chat.errors.reportNotFound",
  "report-resolved": "chat.errors.reportResolved",
  "not-a-resident": "chat.errors.notAResident",
  "not-reportable": "chat.errors.notReportable",
  "already-reported": "chat.errors.alreadyReported",
  "too-many-groups": "chat.errors.tooManyGroups",
  "group-full": "chat.errors.groupFull",
  "comments-closed": "chat.errors.commentsClosed",
  "personal-identity-number": "chat.errors.personalIdentityNumber",
  "too-many-posts": "chat.errors.tooManyPosts",
  "too-many-comments": "chat.errors.tooManyComments",
  "invalid-body": "chat.errors.invalidBody",
} as const satisfies Record<FeedReason | "invalid-body", TranslationKey>;

/**
 * The sentence for a refusal from a chat endpoint.
 *
 * The refusal for a personal identity number carries positions - a field name
 * and a character offset - and none of them is rendered. The two texts it can be
 * about, a message and the note on a report, are each one field on their own
 * form, so naming the field says nothing the sentence has not, and an offset
 * into a textarea is not something a person can act on. What is never rendered
 * is the value: the response does not carry it, and a screen a whole room is
 * looking at is exactly where it must not appear.
 */
export function chatFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(failure, CHAT_FAILURES, "chat.errors.unknown");
}

/**
 * The same, for the form that names a new group. A personal identity number
 * there is in the name rather than in a message, and the sentence says so.
 */
export function chatGroupNameFailureKey(failure: ApiFailure): TranslationKey {
  return failure.reason === "personal-identity-number"
    ? "chat.errors.groupNamePersonalIdentityNumber"
    : chatFailureKey(failure);
}

/**
 * The sentence for a read of a room that failed.
 *
 * The shared branch of {@link failureMessageKey} words a request that never
 * arrived as a save ("could not be saved"), which tells somebody opening a room
 * that something they wrote was lost. A read has nothing to lose, so every
 * failure that is not one of the endpoint's own refusals says the chat could not
 * be read.
 */
export function chatReadFailureKey(failure: ApiFailure): TranslationKey {
  return failure.reason === "offline"
    ? "chat.errors.readFailed"
    : failureMessageKey(failure, CHAT_FAILURES, "chat.errors.readFailed");
}

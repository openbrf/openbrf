import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every reason the comment endpoints answer with.
 *
 * Mirrored from the API's own union rather than imported, like every wire shape
 * in this client, and written out so the map below can be total: a reason added
 * to the API and to this union without a sentence beside it fails the build
 * rather than reaching a resident as a code.
 *
 * Two of them are deliberately vaguer than what happened, and the screen must
 * not undo that in the wording. `news-not-found` answers a news item that does
 * not exist and one the board has not published, as one answer - a resident who
 * could tell those apart could walk the identifiers and learn which notices the
 * board is drafting. `comment-not-found` covers a comment that is gone and one on
 * an item the reader may not see, likewise.
 */
type NewsCommentReason =
  | "news-not-found"
  | "comment-not-found"
  | "personal-identity-number"
  | "too-many-comments";

/**
 * Every refusal this screen can meet, in one sentence each.
 *
 * The API answers with a code rather than prose, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * the screen's decision.
 *
 * `invalid-body` is not one of the module's own reasons - it is the endpoint's
 * schema refusing a body this form should not have been able to send, an empty
 * comment or one past the cap - so it sits beside the union rather than inside
 * it, and the type keeps the totality where totality is worth having.
 *
 * A 403 is answered before this map is consulted at all, by the shared branch in
 * {@link failureMessageKey}. Nothing here needs its own 403 sentence: unlike a
 * motion, no rule about who may comment is a statute about who a person is -
 * `news:comment` belongs to whoever lives in the house, and an account without
 * it is not being told about a right it does not have but about a capability it
 * was not granted.
 */
const NEWS_COMMENT_FAILURES = {
  "news-not-found": "newsReader.errors.newsNotFound",
  "comment-not-found": "newsReader.errors.commentNotFound",
  "personal-identity-number": "newsReader.errors.personalIdentityNumber",
  "too-many-comments": "newsReader.errors.tooManyComments",
  "invalid-body": "newsReader.errors.invalidBody",
} as const satisfies Record<NewsCommentReason | "invalid-body", TranslationKey>;

/**
 * The sentence for a refusal from a news comment endpoint.
 *
 * The refusal for a personal identity number carries positions - a field name
 * and a character offset - and none of them is rendered. A comment has one field,
 * so naming it says nothing the sentence has not, and an offset into a textarea
 * is not something a person can act on. What is never rendered is the value: the
 * response does not carry it, and the screen the whole house reads is exactly
 * where it must not appear.
 */
export function newsCommentFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(
    failure,
    NEWS_COMMENT_FAILURES,
    "newsReader.errors.unknown",
  );
}

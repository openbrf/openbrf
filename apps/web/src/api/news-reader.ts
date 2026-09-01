import { apiRequest, type ApiResult } from "./client";

/**
 * The association's news as the house reads it, and the comments under it.
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Three properties of the contract are load-bearing and none of them is visible
 * in the types, so they are written down here.
 *
 * **A hidden comment's text is the server's answer, never this client's
 * decision.** The API sends `body: null` for a comment struck through and not
 * readable by whoever asked, and the same comment with its text for a moderator
 * and for its author. So the screen renders what it was given. It must not carry
 * a rule of its own about who may read a struck-through comment, because a
 * second rule is a second answer, and the one the reader would see is the one
 * that is not enforced.
 *
 * **The author stays named whatever happens to the text.** Hiding withholds
 * words and never attribution: the comment keeps its place in the thread and its
 * author, so nobody reading afterwards has to guess whether something was
 * removed. There is no route that clears a hide and there is not going to be
 * one - what the board can do is strike a comment through.
 *
 * **A news item is addressed by its identifier here and by its slug on the
 * website.** The two are different readers of the same table: /nyheter is a page
 * anybody can read and knows nothing about identifiers, and a thread is
 * addressed by the identifier of the item it hangs under.
 */

/** A stretch of text carrying its marks, exactly as the API stores it. */
export interface NewsArticleRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /**
   * Where the run links, when it links anywhere.
   *
   * http, https, mailto or a path on this instance. Checked by the API on the
   * way in and again on the way out, so a scheme this platform does not publish
   * never reaches an anchor here - which is what lets this be rendered as an
   * href rather than checked a third time in the browser.
   */
  link?: string;
}

/**
 * One block of a news item's body.
 *
 * Prose only, which is the API's own narrowing rather than this client's: a news
 * item is an announcement, and a block that read a picture or a list of other
 * items out of the database would make one notice a second place where what the
 * association discloses is decided.
 */
export type NewsArticleBlock =
  | { type: "paragraph"; runs: NewsArticleRun[] }
  | { type: "heading"; level: 2 | 3; runs: NewsArticleRun[] };

export interface NewsArticleContent {
  version: number;
  blocks: NewsArticleBlock[];
}

/** One published news item, as the application's own reader is given it. */
export interface NewsArticle {
  id: string;
  /** Its address on the association's website, under /nyheter. */
  slug: string;
  title: string;
  content: NewsArticleContent;
  /** ISO instant it was published. */
  publishedAt: string;
}

/**
 * Who wrote a comment, as the thread may say.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter), whose name the thread withholds even though the board's own
 * address book prints it - and withholds from the board as well, because a name
 * that appeared for some readers of one thread would be a name the person cannot
 * rely on being withheld.
 *
 * `unknown` is an author reference that no longer resolves to a person. A
 * comment is erased on its own clock and a person can be purged out from under
 * one, so a thread has to be able to say "we no longer know" rather than break.
 */
export type NewsCommentAuthor =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** One comment, as this reader is shown it. */
export interface NewsComment {
  id: string;
  author: NewsCommentAuthor;
  /**
   * What was written, or null.
   *
   * Null means the comment is struck through and this reader is neither a
   * moderator nor its author. The comment is still in the list: a hide is a
   * strike-through and never a disappearance.
   */
  body: string | null;
  /** ISO instant it was struck through, or null while it stands. */
  hiddenAt: string | null;
  /** ISO instant it was written. */
  createdAt: string;
}

/** The published news, newest first. Drafts are absent, because they have no thread. */
export function fetchReadableNews(): Promise<ApiResult<NewsArticle[]>> {
  return apiRequest("GET", "/api/news-reader");
}

/** The thread on one news item, oldest first: a thread is read as it was written. */
export function fetchNewsComments(input: {
  newsId: string;
}): Promise<ApiResult<NewsComment[]>> {
  return apiRequest(
    "GET",
    `/api/news-comments/${encodeURIComponent(input.newsId)}`,
  );
}

export function writeNewsComment(input: {
  newsId: string;
  body: string;
}): Promise<ApiResult<NewsComment>> {
  return apiRequest(
    "POST",
    `/api/news-comments/${encodeURIComponent(input.newsId)}`,
    { body: input.body },
  );
}

/**
 * Strikes a comment through.
 *
 * `site:manage`, which is what the board already holds for publishing in the
 * cooperative's name: a comment thread under a notice is part of what the
 * association publishes. There is deliberately no counterpart that clears it.
 */
export function hideNewsComment(input: {
  commentId: string;
}): Promise<ApiResult<NewsComment>> {
  return apiRequest(
    "POST",
    `/api/news-comment-moderation/${encodeURIComponent(input.commentId)}/hide`,
  );
}

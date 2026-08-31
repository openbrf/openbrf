import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/** Where in a comment a refused value sits. */
export interface NewsCommentTextLocation {
  /** The only free-text field a comment has. */
  part: "body";
  /** Where in the body the refused value starts. */
  offset: number;
}

export type NewsCommentReason =
  | "news-not-found"
  | "comment-not-found"
  | "personal-identity-number"
  | "too-many-comments";

/**
 * A refusal from the news comment thread.
 *
 * Two of the reasons are deliberately vaguer than what actually happened, on
 * the precedent `issues/issue.error.ts` sets and for the same reason.
 *
 * `news-not-found` answers a news item that does not exist and one that is not
 * published, without distinguishing them. A comment is exactly as visible as the
 * item it sits on, so a draft has no thread; telling a caller that an
 * unpublished item exists would let a resident enumerate the board's drafts one
 * identifier at a time, which is precisely what the website's own single null
 * for "no such item", "not published" and "members only" exists to prevent.
 *
 * `comment-not-found` answers a comment that does not exist and one on an item
 * the caller may not see, likewise as one answer.
 *
 * The refusal for a personal identity number names positions and never the
 * value: the thing the scan caught is exactly the thing that must not travel
 * back in a response body, into a log, or onto a screen somebody else is looking
 * at.
 */
export class NewsCommentError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: NewsCommentReason,
    private readonly found: readonly NewsCommentTextLocation[] = [],
  ) {
    super(message);
    this.status =
      reason === "too-many-comments"
        ? HttpStatus.TOO_MANY_REQUESTS
        : reason === "personal-identity-number"
          ? // Understood and refused on its merits: this comment may not be
            // written as it stands, and its author is told where to change it.
            HttpStatus.UNPROCESSABLE_ENTITY
          : HttpStatus.NOT_FOUND;
  }

  /**
   * Where the refusal is, in one shape for every reason.
   *
   * One key rather than one per rule, so the screen has one thing to render.
   * Positions and a field name only: what was found is exactly what must not
   * travel back.
   */
  override details(): Record<string, readonly unknown[]> {
    return { locations: this.found };
  }
}

import { HttpStatus } from "@nestjs/common";
import {
  type FeedReason,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import { DomainError } from "../http/domain-error";

/** Where in a piece of written text a refused value sits. */
export interface FeedTextLocation {
  /**
   * Which field it was in.
   *
   * A post and a comment have one. A report carries a note beside the post it is
   * about, and that note is written by a resident like everything else here, so
   * it is scanned on the same rule and the refusal has to be able to say which
   * of the two the reader is looking at. A group's name is shown to everybody in
   * the group and to the board, so it is scanned on the same rule, and so is the
   * title of a post written as Styrelsen, which is its news item's.
   */
  part: "body" | "note" | "name" | "title";
  /** Where in that text the refused value starts. */
  offset: number;
}

/**
 * A refusal from the feed.
 *
 * `audience-not-found` is deliberately vaguer than what happened, on the
 * precedent `news-comment.error.ts` sets and for the same reason. It answers an
 * audience that does not exist and one this person is not in, without
 * distinguishing them. Telling a caller that a group they cannot read exists
 * would let anybody holding `chat:participate` walk the identifier space and
 * learn what groups the house has made - and a group is invisible to somebody
 * who is not in it, which only holds if the two answers are one answer
 * (ADR 0012).
 *
 * `post-not-found` and `comment-not-found` are vague in exactly the same way and
 * for the same reason: each answers something that does not exist and something
 * in an audience this person is not in, so an identifier cannot be used to find
 * out what is being said where somebody is not. `image-not-found` answers a file
 * that does not exist, one somebody else uploaded and one already on a post as
 * one answer, so a post cannot be written to find out whether a file is there.
 *
 * The rest say what happened, because none of them tells the caller anything
 * they did not already know. `not-a-resident` is the association telling
 * somebody a group is for the people who live here; `not-reportable` is
 * Styrelsen having no strike-through, which is a published rule;
 * `comments-closed` is a post that takes no comments, which its reader can see;
 * `post-erased` is a post the purge has erased, which its reader sees too;
 * and `already-reported` and `report-resolved` are about acts the caller made or
 * the board has already answered. `too-many-groups` and `group-full` are the
 * two bounds a list has to have to stay a list, `too-many-images` the bound a
 * post has, and `too-many-uploads` the bound on what one account puts in
 * storage in a day. `not-board`, `board-post-audience` and `not-pinnable` are
 * the board's tools refusing what only the board does, or what the board does
 * only in Alla, and `schedule-out-of-range` an instant that is not ahead.
 * `not-editable` is an edit of something the caller did not write as
 * themselves, or that the board struck; `too-many-edits` the bound on how many
 * earlier versions one post or comment keeps, which is a bound on what one
 * thing becomes rather than on a rate, and so not a 429; `history-withheld`
 * the earlier versions of something the caller may read but neither wrote nor
 * answers for as the board; `not-important` the must-read list asked of an
 * ordinary post; and `not-scheduled` a cancellation of a post written as
 * Styrelsen that is no longer waiting for its instant. Each is about a thing
 * the caller can already read, so none tells them anything new.
 *
 * The refusal for a personal identity number names positions and never the
 * value: the thing the scan caught is exactly the thing that must not travel
 * back in a response body, into a log, or onto a screen somebody else is
 * looking at.
 */
export class FeedError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: FeedReason,
    private readonly found: readonly FeedTextLocation[] = [],
  ) {
    super(message);
    this.status =
      reason === "too-many-posts" ||
      reason === "too-many-comments" ||
      reason === "too-many-uploads"
        ? HttpStatus.TOO_MANY_REQUESTS
        : reason === "audience-not-found" ||
            reason === "post-not-found" ||
            reason === "comment-not-found" ||
            reason === "report-not-found" ||
            reason === "image-not-found"
          ? HttpStatus.NOT_FOUND
          : /*
             * Understood and refused on its merits: what was asked for is a
             * thing this application does not do, and the caller is told which.
             * Not a 403, which is the guard's answer about a capability - these
             * callers hold the capability and are being told about the act.
             */
            HttpStatus.UNPROCESSABLE_ENTITY;
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

/**
 * Refuses text carrying a Swedish personal identity number.
 *
 * The same rule a page, a news item and a news comment live under. The board may
 * read the apartment register, and DESIGN.md forbids a personal identity number
 * outside the register views for exactly that reason: a number copied out of the
 * register into the feed is a second copy the register cannot account for, held
 * on a different clock, in front of neighbours the register's own rules do not
 * reach.
 *
 * Taken by a post, a comment, a group's name and the note on a report: each is
 * text a resident typed, and the one that goes to the board is no more entitled
 * to carry a number than the one that stays in the group.
 */
export function refusePersonalIdentityNumbers(
  text: string,
  part: FeedTextLocation["part"] = "body",
): void {
  const locations = scanForPersonalIdentityNumbers(text).map(
    (hit): FeedTextLocation => ({ part, offset: hit.index }),
  );

  if (locations.length > 0) {
    throw new FeedError(
      "The text carries a personal identity number and cannot be written.",
      "personal-identity-number",
      locations,
    );
  }
}

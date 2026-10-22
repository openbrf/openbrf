import type { Principal } from "../authorization/capabilities";
import type { Prisma } from "../generated/prisma/client";
import type { AudienceKind } from "../generated/prisma/enums";
import { holdsBoardSeat } from "../mail/board-recipients";
import type { FeedDbClient } from "./feed-audience";

/**
 * Who answers a report, which reports are still asking, and where the board
 * moderates at all: the rules behind the board's moderation of the feed
 * (`post-report.service.ts`).
 *
 * In a file of their own because several paths ask them and must not answer
 * them differently. The report queue reads a reported post's text by them, the
 * media route serves the post's images by them (`feed-image.ts`) - a picture is
 * part of what was said, and a board that read the caption of a post it could
 * not see the photograph of would be deciding about half of it - the feed
 * offers a reader the report and the strike by them, and the report is refused
 * by the same answer. Any of those restating the rule would be the one that
 * drifts.
 */

/**
 * Whether a post or a comment in this audience can be reported to the board,
 * and struck through after a report.
 *
 * Alla and a group. Not Styrelsen, where the board is the whole audience and a
 * board able to strike a colleague's line would be deciding what the record of
 * its own deliberation says; and not Administratörer, which is the board and
 * the people who run the instance writing to each other, and has nobody else in
 * it to answer to.
 */
export function isModerated(kind: AudienceKind): boolean {
  return kind === "ALL" || kind === "GROUP";
}

/**
 * Whether the board strikes a post or a comment in this audience through
 * without anybody reporting it first.
 *
 * Alla alone. The board is in Alla, reads everything said there and answers for
 * it, so waiting for a neighbour to ask would only make the board slower at
 * something it may already see. A group is the opposite case: the board reaches
 * one only through a report from inside it (ADR 0012), and a board member who
 * happens to be in the group is not the board there.
 */
export function strikesWithoutReport(kind: AudienceKind): boolean {
  return kind === "ALL";
}

/** A post or a comment, as far as its moderation turns on it. */
export interface ModeratedThing {
  /** The audience it was said in: a comment's is its post's. */
  kind: AudienceKind;
  authorPersonId: string | null;
  /**
   * A post written as Styrelsen: a news item, which the board takes down on
   * the news screen, and which is neither reported nor struck. False for a
   * comment, which is one person's words whoever it answers.
   */
  newsItem: boolean;
  struckAt: Date | null;
  /** When the purge erased a post's text. Null for a comment, which it deletes. */
  erasedAt: Date | null;
}

/** A post, as its moderation turns on it. */
export function moderatedPost(post: {
  audience: { kind: AudienceKind };
  authorPersonId: string | null;
  byBoard: boolean;
  struckAt: Date | null;
  erasedAt: Date | null;
}): ModeratedThing {
  return {
    kind: post.audience.kind,
    authorPersonId: post.authorPersonId,
    newsItem: post.byBoard,
    struckAt: post.struckAt,
    erasedAt: post.erasedAt,
  };
}

/**
 * A comment, as its moderation turns on it: in the audience of the post it is
 * under, and never a news item, whoever it answers.
 */
export function moderatedComment(
  comment: { authorPersonId: string; struckAt: Date | null },
  kind: AudienceKind,
): ModeratedThing {
  return {
    kind,
    authorPersonId: comment.authorPersonId,
    newsItem: false,
    struckAt: comment.struckAt,
    erasedAt: null,
  };
}

/** Who is asking, as far as their moderation turns on it. */
export interface ModerationReader {
  personId: string;
  /** Whether they answer reports: {@link answersReports}. */
  moderates: boolean;
  /** Whether they already hold a report of this, open or answered. */
  reported: boolean;
}

/**
 * Whether the board strikes this through without a report: a resident's post,
 * or a comment, in Alla, still standing.
 */
export function strikeableWithoutReport(thing: ModeratedThing): boolean {
  return (
    strikesWithoutReport(thing.kind) &&
    !thing.newsItem &&
    thing.struckAt === null &&
    thing.erasedAt === null
  );
}

/**
 * Whether this reader may report a post or a comment to the board, and whether
 * they may strike it through themselves: never both, because the board in
 * Alla strikes rather than reporting to itself.
 *
 * A report is of somebody else's words in Alla or a group, neither struck -
 * which has been answered - nor erased, which has nothing left on it to report,
 * and not a news item. One person reports one thing once, so a reader who holds
 * a report of it is not offered a second.
 *
 * The feed offers the two by this, and the report is refused by it: an offer
 * the server did not hold to would be a button for anybody who can send a
 * request without it.
 */
export function moderationOf(
  thing: ModeratedThing,
  reader: ModerationReader,
): { mayReport: boolean; mayStrike: boolean } {
  const mayStrike = reader.moderates && strikeableWithoutReport(thing);
  return {
    mayReport:
      !mayStrike &&
      !reader.reported &&
      isModerated(thing.kind) &&
      !thing.newsItem &&
      thing.struckAt === null &&
      thing.erasedAt === null &&
      thing.authorPersonId !== reader.personId,
    mayStrike,
  };
}

/**
 * A report the board has not yet answered.
 *
 * The queue is these and nothing else, and so is what a report opens: once
 * the board has struck the post or left it standing, the question is answered
 * and the post is back behind its group. A resolved report is the record of a
 * decision, not a standing permission to look.
 */
export const OPEN_REPORT = {
  resolvedAt: null,
} as const satisfies Prisma.PostReportWhereInput;

/**
 * Whether this account answers reports today: `chat:moderate` and a board seat.
 *
 * Both, on the groups' own division. The capability opens the endpoint and the
 * register decides what is behind it, because `ADMIN_CAPABILITIES` is every
 * capability: the instance's administrator holds `chat:moderate` and no seat,
 * and a report carries a private group's post in full.
 *
 * The report routes have the capability checked by their guard already; the
 * media route has no capability to guard on, so the question is asked whole.
 */
export async function answersReports(
  db: FeedDbClient,
  principal: Principal,
  now: Date,
): Promise<boolean> {
  return (
    principal.capabilities.has("chat:moderate") &&
    (await holdsBoardSeat(db, principal.personId, now))
  );
}

/**
 * Whether somebody has carried this post out to the board, and the board has
 * not yet answered. A report of a comment under it opens nothing of the post.
 *
 * Never an erased post. The purge takes a post's reports with its text, so an
 * open report on one cannot stand; it is asked all the same, because what this
 * opens is the post's pictures and an erased post has none to open.
 */
export async function isReportedToBoard(
  db: FeedDbClient,
  postId: string,
): Promise<boolean> {
  const open = await db.postReport.count({
    where: { postId, ...OPEN_REPORT, post: { erasedAt: null } },
  });
  return open > 0;
}

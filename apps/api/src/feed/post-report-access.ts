import type { Principal } from "../authorization/capabilities";
import type { Prisma } from "../generated/prisma/client";
import { holdsBoardSeat } from "../mail/board-recipients";
import type { FeedDbClient } from "./feed-audience";

/**
 * Who answers a report, and which reports are still asking: the two halves of
 * the board's one way into a group (`post-report.service.ts`).
 *
 * In a file of their own because two paths ask them and must not answer them
 * differently. The report queue reads a reported post's text by them, and the
 * media route serves the post's images by them (`feed-image.ts`) - a picture is
 * part of what was said, and a board that read the caption of a post it could
 * not see the photograph of would be deciding about half of it. Either path
 * restating the rule would be the one that drifts.
 */

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
 * Whether somebody in its group has carried this post out to the board, and
 * the board has not yet answered.
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

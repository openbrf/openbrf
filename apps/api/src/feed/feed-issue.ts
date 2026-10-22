import type { Principal } from "../authorization/capabilities";
import type { Prisma } from "../generated/prisma/client";
import { holdsBoardSeat } from "../mail/board-recipients";
import { postFor } from "./feed-audience";

/**
 * A post's issue report (felanmälan): the link from a post to the report made
 * from it, and who may make it (ADR 0026, "Post to issue report").
 *
 * The issue module files the report, under its own capability and its own
 * rules, and calls {@link linkIssueToPost} in the transaction that files it,
 * so a report is never filed against a post it could not be linked to and a
 * link never names a report that was not filed. Which posts may carry one is
 * the feed's question and is answered here, on the feed's own audience check.
 */

/** What linking a report to a post came to. */
export type IssueLinkOutcome =
  /** The post now names the report. */
  | "linked"
  /**
   * There is no such post, or the reporter may not read it: one answer, as
   * every path into the feed gives (ADR 0012).
   */
  | "post-not-found"
  /**
   * The reporter may read the post but may not report from it: they neither
   * wrote it nor hold a board seat, or the purge has erased it.
   */
  | "not-reportable"
  /** A report has already been made from the post. */
  | "already-reported";

/**
 * Links a report just filed to the post it was made from, inside the
 * transaction that filed it.
 *
 * ## Who may
 *
 * The post's writer, and a board seat holder. The writer, because the fault is
 * theirs to report and they are who the board would otherwise ask to; the
 * board, because three posts in ten about a house are about a fault, and the
 * board turning one into a report is the board doing what the post asked. Not a
 * neighbour who read it: a second report about somebody else's words, with
 * somebody else's photographs, is not theirs to make - they can say so under
 * the post, or report the fault themselves. Only from a post the reporter may
 * read, which is the feed's one check, so a group's post is refused to a board
 * outside the group exactly as one that does not exist.
 *
 * ## One report per post
 *
 * The post's row is read under its own lock and linked only while it names no
 * report, so two presses - the writer's and the board's - file one report that
 * the post carries and refuse the other, which the caller's transaction then
 * takes back with the report it filed. The lock is the row's, so this also
 * waits for the purge erasing the post and finds it erased.
 */
export async function linkIssueToPost(
  tx: Prisma.TransactionClient,
  reporter: Principal,
  postId: string,
  issueId: string,
  now: Date,
): Promise<IssueLinkOutcome> {
  const post = await postFor(tx, postId, reporter.personId, now);
  if (post === null) {
    return "post-not-found";
  }
  if (
    post.authorPersonId !== reporter.personId &&
    !(await holdsBoardSeat(tx, reporter.personId, now))
  ) {
    return "not-reportable";
  }

  const [row] = await tx.$queryRaw<
    { issueId: string | null; erasedAt: Date | null }[]
  >`SELECT "issueId", "erasedAt" FROM "post" WHERE "id" = ${post.id} FOR UPDATE`;
  if (row === undefined) {
    return "post-not-found";
  }
  if (row.erasedAt !== null) {
    return "not-reportable";
  }
  if (row.issueId !== null) {
    return "already-reported";
  }

  await tx.post.update({ where: { id: post.id }, data: { issueId } });
  return "linked";
}

import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it posts to an audience or erases one.
 *
 * A group with nothing in it is erased by the nightly sweep, and a post can be
 * written to that group at the same moment. Both sides of the decision are a
 * read taken before the row that would change its answer exists: the sweep reads
 * "this group holds no post" and then deletes, and the write reads "this group
 * is mine to post to" and then inserts. At READ COMMITTED - the isolation
 * everything in this application runs at - the insert can commit in the gap
 * between the sweep's read and its delete, and the delete then cascades the
 * post away. The writer is told their post was stored, and the group and the
 * post are both gone.
 *
 * The foreign key does not close it. A child insert takes FOR KEY SHARE on the
 * parent row, so the delete waits for the writer to commit - and then proceeds
 * and cascades. Waiting is not refusing.
 *
 * An advisory lock rather than an isolation level, for the reason
 * `legal-hold-lock.ts` gives: the invariant is derived from a set of rows - "no
 * post points at this group" - and no single row carries it, so no constraint
 * can state it. Serializable would state it, at the price of retry handling on
 * every post anybody writes, for a contention this application never has: the
 * sweep runs once a night and only ever reaches a group nobody has posted to for
 * a year.
 *
 * Held here rather than beside either writer because the lock only works if
 * every writer uses the same key. A second spelling of this string would be two
 * locks that never meet, which is worse than no lock at all: it reads as
 * serialised and is not.
 *
 * The key is namespaced and hashed to the int4 the lock space is addressed in. A
 * collision between two audiences costs one of them a short wait and nothing else.
 * Taken for the transaction, so the commit or the rollback releases it with
 * nothing left to remember to unlock.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockAudience(
  tx: Prisma.TransactionClient,
  audienceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audience:${audienceId}`}))`;
}

/**
 * The lock a transaction takes before it stamps a post with its instant.
 *
 * The feed is polled on `(createdAt, id)` across every audience a person is in
 * (ADR 0010), so a post stamped at an instant some other post has already been
 * delivered past would never be delivered at all. Two posts written together to
 * two audiences are exactly that case: each reads the clock, the later stamp
 * commits first, a screen polls it, and its cursor is now beyond the earlier
 * stamp, which commits a moment afterwards. So a post is stamped later than every
 * post already in the feed, under this one key, and the order the instants say is
 * the order the posts were committed in.
 *
 * One key for the whole feed rather than one per audience, because the poll
 * that has to be right is the one across audiences. It serialises posting and
 * nothing else - a house writes a few posts an hour - and it is held only for the
 * read of the newest instant and the insert.
 */
export async function lockFeedOrder(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"feed-order"}))`;
}

/**
 * The lock a transaction takes before it stamps a comment with its instant.
 *
 * {@link lockFeedOrder}'s argument, one level down. An open thread is polled on
 * `(createdAt, id)` under its post (ADR 0010), and two neighbours answering at
 * once each read the clock before either commits: the later stamp commits
 * first, a reader's poll delivers it, and the earlier one commits behind a
 * cursor that has already passed it and is never delivered at all. So a comment
 * is stamped later than every comment already under its post, under this key.
 *
 * One key per post rather than one for the feed, because a thread is polled
 * only within its own post: comments under two posts have no order between them
 * that anybody reads. Taken after the writer's own {@link lockFeedPerson}, and
 * held only for the read of the newest instant and the insert.
 */
export async function lockPostThread(
  tx: Prisma.TransactionClient,
  postId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`post-thread:${postId}`}))`;
}

/**
 * The lock the board takes before it answers a report, and a reporter before
 * they make one.
 *
 * Keyed on the post rather than on the report, because what the board decides
 * is about the post: striking one report through closes every other report of
 * the same post, and so does leaving it standing. Two answers arriving
 * together - one press on each of two reports of one post - would otherwise both
 * pass their own check, and the record would say the board left a post
 * standing while the post carries a strike. That is worse than either answer,
 * because the log of what the board decided would be false.
 *
 * The claim on the report is a conditional update and settles a second press on
 * the same report by itself. This is what settles two presses on two reports,
 * which no single row can: the invariant is across the set of reports about one
 * post, and `legal-hold-lock.ts` gives the argument for an advisory lock over
 * an isolation level in that case.
 *
 * Taken for the transaction, like every other lock here, and hashed into the
 * same int4 space: a collision costs one board member a short wait.
 */
export async function lockPost(
  tx: Prisma.TransactionClient,
  postId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`post:${postId}`}))`;
}

/**
 * {@link lockPost} for a comment: the lock the board takes before it answers a
 * report of a comment or strikes one through, and a reporter before they make
 * one.
 *
 * Keyed on the comment, because a report of a comment is a question about that
 * comment alone: striking it closes every open report of it, and leaving it
 * standing does too. The post it is under is not asked, and a comment in a
 * group carries nothing of its post to the board.
 */
export async function lockComment(
  tx: Prisma.TransactionClient,
  commentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comment:${commentId}`}))`;
}

/**
 * The lock a transaction takes before it counts what one person has written,
 * or how many groups they are in, and then adds to it.
 *
 * The write limits are a bound over a set of rows - a person's posts or
 * comments in the window, their memberships - and no row carries it, so a count
 * taken outside the insert lets a burst of parallel requests each count under
 * the limit and all be stored. Counting under this lock serialises one person's
 * writes and nobody else's. One key for posts and comments alike, the news
 * screen's comments included, because they are one person's writing in one
 * feed.
 *
 * Taken before any audience's lock wherever a transaction takes both, so two
 * transactions never wait on each other's locks in opposite orders.
 */
export async function lockFeedPerson(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`feed-person:${personId}`}))`;
}

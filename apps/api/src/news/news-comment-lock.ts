import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it counts the comments one person has
 * written and then adds one.
 *
 * The comment allowance is a bound over a set of rows - a person's comments in
 * the window - and no row carries it, so a count taken outside the insert lets
 * a burst of parallel requests each count under the allowance and all be
 * stored. Counting under this lock serialises one person's comments and nobody
 * else's. `legal-hold-lock.ts` gives the argument for an advisory lock over an
 * isolation level in that case.
 *
 * Held here rather than beside the writer, like every other lock in this
 * application: the lock only works if every writer uses the same key, and a
 * second spelling of it would be two locks that never meet.
 *
 * Namespaced, hashed to the int4 the lock space is addressed in, and taken for
 * the transaction, so the commit or the rollback releases it. A collision
 * between two people costs one of them a short wait.
 */
export async function lockNewsCommentAuthor(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`news-comment-author:${personId}`}))`;
}

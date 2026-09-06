import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it changes one breach record.
 *
 * The rule this protects is art. 33(1)'s last sentence: a notification made
 * later than the bound carries the reasons for the delay. Whether it is broken
 * is not a property of any one column. It is a property of three - the
 * discovery instant the bound is counted from, the instant IMY was notified,
 * and the reasons - so no constraint can state it and every writer has to read
 * all three before it writes any of them.
 *
 * Two writers reading before either commits is enough to break it without
 * either one being wrong on its own. One moves the discovery date earlier,
 * which turns an existing notification into a late one, and keeps the reasons
 * standing. The other clears the reasons, having checked them against the
 * discovery date as it was. Each passes; together they leave a record saying
 * the association notified the authority after the bound and declining to say
 * why - which is the one thing the sentence exists to prevent, on the register
 * the association would produce to demonstrate that it did not.
 *
 * An advisory lock rather than serializable, for the reason
 * `legal-hold-lock.ts` gives: the invariant spans a read and a write rather
 * than a row, and a cooperative records a handful of these in its life, so
 * retry handling on every writer would buy nothing.
 *
 * Held here rather than beside either writer because a lock only works if every
 * writer takes the same key.
 */
export async function lockBreach(
  tx: Prisma.TransactionClient,
  breachId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`personal-data-breach:${breachId}`}))`;
}

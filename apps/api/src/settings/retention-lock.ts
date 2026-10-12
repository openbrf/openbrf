import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it reads the time service data is kept
 * after a move-out, when it is about to change it.
 *
 * The change is audited with the value it replaced, and that value is read
 * before the write. At READ COMMITTED - the isolation everything in this
 * application runs at - two administrators saving at once both read the same
 * old value: one sets 730 days, the other then sets 30, and the log says the
 * second replaced the old value rather than 730. The append-only log would then
 * misstate, for good, who brought a former resident's purge date forward and
 * from what, which is the question this entry exists to answer about an erasure
 * that cannot be undone. Ordered by this key, the second save reads what the
 * first one wrote.
 *
 * An advisory lock for the reason `legal-hold-lock.ts` gives, and held here
 * rather than beside the writer because a lock only works if every writer uses
 * the same key. Taken for the transaction, so the commit or the rollback
 * releases it.
 */
export async function lockRetentionPolicy(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"association-retention"}))`;
}

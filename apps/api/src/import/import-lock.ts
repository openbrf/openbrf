import type { Prisma } from "../generated/prisma/client";

/**
 * The lock every chunk of every import takes before it writes.
 *
 * One key for the instance: what it serialises is the decision "this person is
 * new", which any two chunks can disagree on whichever imports they belong to.
 * The chunk plans again once it holds it, so what it writes was decided
 * against a register no other chunk is adding to.
 *
 * Held here rather than inline in the apply because a lock only works if every
 * writer spells the key the same way, as `fees/fee-lock.ts` says of its own.
 * Taken for the transaction, so the commit or the rollback releases it.
 */
export async function lockImportChunkWrite(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"import-apply"}))`;
}

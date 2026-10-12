import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it reads a document in the archive that
 * it is about to change.
 *
 * An edit records what it changed, and what it changed is the difference
 * between the row it read and the values it writes. At READ COMMITTED - the
 * isolation everything in this application runs at - two saves of one document
 * both read the same old row, and the later write wins over a value its own
 * audit entry never compared against: a save that moves board minutes back off
 * the public shelf, or puts them on it, would then commit without the audience
 * change being named in the log. Ordered by this key, the second save reads
 * what the first one wrote, so every entry names the change its own write made.
 *
 * An advisory lock for the reason `legal-hold-lock.ts` gives, and held here
 * rather than beside the writer because a lock only works if every writer uses
 * the same key: a second spelling of this string would read as serialised
 * without being so. Taken for the transaction, so the commit or the rollback
 * releases it.
 */
export async function lockDocument(
  tx: Prisma.TransactionClient,
  documentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document:${documentId}`}))`;
}

import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it counts the bytes an apartment's binder
 * holds and adds an entry to it.
 *
 * The room a binder has (ADR 0017) is a count of what is filed, and a count
 * only bounds anything if nothing is filed between reading it and writing the
 * entry that spends it. At READ COMMITTED - the isolation everything in this
 * application runs at - two uploads that arrive together both read the same
 * total, both fit, and both commit, which is how a binder passes its bound.
 * Ordered by this key, the second count sees the first entry.
 *
 * An advisory lock for the reason `legal-hold-lock.ts` gives, and held here
 * rather than beside the writer because a lock only works if every writer uses
 * the same key. Taken for the transaction, so the commit or the rollback
 * releases it.
 */
export async function lockApartmentBinder(
  tx: Prisma.TransactionClient,
  apartmentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`apartment-binder:${apartmentId}`}))`;
}

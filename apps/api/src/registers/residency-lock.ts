import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it decides what the member register owes
 * a person.
 *
 * Membership is not a column. It is derived from the set of tenant-ownerships a
 * person holds - it begins with the first and ends with the last - so every
 * writer decides what to append by counting the person's other residencies, and
 * that count is read before the row that would change its answer exists. Two
 * writers for one person running at once each read a state the other is about
 * to invalidate: two arrivals would both find no membership running and both
 * append an ENTRY, and two departures would each see the other's apartment as
 * still held and neither would append the EXIT. The register refuses UPDATE and
 * DELETE, so the first mistake cannot be removed and the second can only be
 * answered by a later correction row.
 *
 * An advisory lock rather than a constraint, because the invariant is "one
 * membership per person for as long as a tenant-ownership is held" and it is
 * derived from a set of residency rows. No single row carries it, so no unique
 * index can state it. Taken before the transaction reads anything about the
 * person, and released by the commit or the rollback with nothing left to
 * remember to unlock.
 *
 * The key is namespaced and hashed to the int4 the lock space is addressed in.
 * A collision between two persons costs one of them a short wait and nothing
 * else.
 *
 * Held here rather than beside either writer because the lock only works if
 * every writer uses the same key: the move flows and the import apply are
 * separate paths into one register, and a second spelling of this string would
 * be two locks that never meet.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockResidencyTransitions(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`residency:${personId}`}))`;
}

/**
 * Takes the transition lock for several persons, in an order every caller
 * agrees on.
 *
 * A transaction that writes for one person takes one lock and can wait for
 * nothing else, so it can never be half of a deadlock. A transaction that
 * writes for many - the import applies a chunk of rows at a time - can be:
 * two chunks holding one lock each and each waiting for the other's is a cycle,
 * and Postgres resolves a cycle by killing one of the transactions in it.
 * Sorting the ids removes the cycle, because it takes two transactions
 * disagreeing about the order of the same pair to make one.
 *
 * Deduplicated, since a chunk usually holds several rows for one person, and
 * sorted here rather than at the call site so that the order is a property of
 * taking the locks rather than something each caller has to remember.
 *
 * The number held at once is bounded by the number of rows the caller writes
 * for - a chunk of the import, so a hundred at the most - and they are released
 * by the commit like any other.
 */
export async function lockResidencyTransitionsInOrder(
  tx: Prisma.TransactionClient,
  personIds: Iterable<string>,
): Promise<void> {
  for (const personId of [...new Set(personIds)].sort()) {
    await lockResidencyTransitions(tx, personId);
  }
}

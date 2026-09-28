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

/**
 * The lock a transaction takes before it adds a residency to an apartment, or
 * decides anything from the set of people who have ever lived there.
 *
 * The transition lock above is keyed on a person, and some readers cannot name
 * the person they are racing. The charge and fee purges erase an apartment's
 * rows when no legal hold stands against anybody who has ever held a residency
 * there, so they read the apartment's residents and then check each of them.
 * A residency committing between that read and the delete - an import bringing
 * in the history of a household that left years ago, whose member is under a
 * hold - adds a person the purge never checked, and the rows the hold was
 * placed to preserve go. The per-person key cannot close that gap, because the
 * purge does not know which person to take it for until the residency exists.
 *
 * So the key is the apartment. Every writer that creates a residency takes it
 * for the apartment it writes to, and a reader that decides from the residents
 * takes it before it reads them: the writer either commits first and is seen,
 * or waits for the reader to commit.
 *
 * Only adding a residency takes it. A move-out changes a date and not who has
 * lived in the flat, and a residency is removed only by the residency purge,
 * which a hold stops for the held person - so neither can leave a reader
 * missing somebody it should have checked.
 *
 * Taken first, before any other key a transaction holds. The purges take this
 * and then the legal hold keys of the residents they found, and the residency
 * purge and the erasure request already take a person's legal hold key and then
 * their transition key; a writer taking the transition key and then this one
 * would close that into a cycle of three transactions each waiting on the next.
 * Apartment, then legal hold, then transition is an order every one of them
 * keeps.
 */
export async function lockApartmentResidencies(
  tx: Prisma.TransactionClient,
  apartmentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`residency-apartment:${apartmentId}`}))`;
}

/**
 * Takes the apartment lock for several apartments, in an order every caller
 * agrees on, for the reason `lockResidencyTransitionsInOrder` gives: an import
 * chunk writes residencies on many apartments at once, and two chunks taking
 * the same pair in opposite orders would deadlock.
 */
export async function lockApartmentResidenciesInOrder(
  tx: Prisma.TransactionClient,
  apartmentIds: Iterable<string>,
): Promise<void> {
  for (const apartmentId of [...new Set(apartmentIds)].sort()) {
    await lockApartmentResidencies(tx, apartmentId);
  }
}

/**
 * Everybody who has ever held a residency on one apartment.
 *
 * Beside the lock because the answer is only as good as the lock it is read
 * under: read through the transaction that holds `lockApartmentResidencies`
 * for the same apartment, it cannot be missing a residency that commits before
 * that transaction does.
 */
export async function residentsOf(
  tx: Prisma.TransactionClient,
  apartmentId: string,
): Promise<string[]> {
  const residencies = await tx.residency.findMany({
    where: { apartmentId },
    select: { personId: true },
    distinct: ["personId"],
  });
  return residencies.map((residency) => residency.personId);
}

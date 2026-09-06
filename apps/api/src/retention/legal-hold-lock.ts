import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it decides whether a person is held.
 *
 * A legal hold is the one thing that stops an erasure, and both sides of that
 * decision are a read taken before the row that would change its answer exists.
 * A purge reads "no hold stands" and then deletes; a placement reads "no hold
 * stands" and then inserts. At READ COMMITTED - the isolation everything in
 * this application runs at - the placement can commit in the gap between the
 * purge's read and its delete, and the purge then erases exactly the rows the
 * hold was placed to preserve. The board member who clicked that button is told
 * the person is held, and the data is already gone.
 *
 * An advisory lock rather than an isolation level, for the reason
 * `residency-lock.ts` gives: the invariant is derived from a set of rows and no
 * single row carries it, so no constraint can state it. Serializable would
 * state it, at the price of retry handling on every writer that touches a hold,
 * for a contention this application never has - a hold is placed a handful of
 * times in a cooperative's life and the purge runs once a night.
 *
 * Held here rather than beside either writer because the lock only works if
 * every writer uses the same key. A second spelling of this string would be two
 * locks that never meet, which is worse than no lock at all: it reads as
 * serialised and is not.
 *
 * The key is namespaced and hashed to the int4 the lock space is addressed in.
 * A collision between two persons costs one of them a short wait and nothing
 * else. Taken for the transaction, so the commit or the rollback releases it
 * with nothing left to remember to unlock.
 *
 * Placing takes it and releasing does not. A release racing a purge is harmless
 * whichever way it lands: the purge either still sees the hold and leaves the
 * data for tomorrow's run, or it does not and erases data the board has just
 * stopped protecting - which is what releasing the hold asked for.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockLegalHold(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${personId}`}))`;
}

/**
 * The lock a transaction takes when it cannot name the person it is racing.
 *
 * Every purge above this one is keyed on a person: it is erasing that person's
 * rows, so it knows the id, takes the key above and reads the hold underneath
 * it. The board mailbox is not. A thread is keyed on an address an envelope
 * asserted, and which person that address belongs to - if any - is discovered by
 * computing each held person's own index and comparing, which answers "nobody"
 * in the ordinary case. There is then no person to lock on, and a placement for
 * somebody the scan did not see can commit between the scan and the delete: the
 * board member is told the person is held, and the correspondence has gone.
 *
 * So the key is the registry rather than a row in it. A writer that can name its
 * person takes this as well as its own, and a reader that cannot name one takes
 * this alone - which is what lets the two meet at all, since a per-person key
 * cannot be guessed by a transaction that does not know the person.
 *
 * The cost is that placements and address-keyed purges run one at a time. That
 * is the same trade the per-person key already makes, at a scale that makes it
 * free: a hold is placed a handful of times in a cooperative's life, the purge
 * runs once a night, and the two contending means one of them waits for the
 * other to commit, which is the point.
 *
 * Releasing does not take it, for the reason releasing does not take the other:
 * a release racing a purge lands either way harmlessly.
 */
export async function lockLegalHoldRegistry(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"legal-hold:registry"}))`;
}

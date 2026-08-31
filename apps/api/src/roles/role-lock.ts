import type { Prisma } from "../generated/prisma/client";

/**
 * The locks a role change takes before it reads the state it is about to
 * change.
 *
 * Both rules this module enforces are derived from a set of rows rather than
 * carried by any one of them, so no unique index can state either, and both are
 * decided by a read that happens before the row that would change its answer
 * exists. That is the same shape as the member register's transition lock, and
 * it is taken the same way: an advisory lock held for the transaction, released
 * by the commit or the rollback with nothing left to remember to unlock.
 *
 * The keys are namespaced and hashed to the int4 the lock space is addressed
 * in. A collision costs the loser a short wait and nothing else.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */

/**
 * Held while a person's board seats are read and written.
 *
 * The invariant is "at most one held seat per person and position". Two
 * elections to the same position arriving at once would each read no held seat
 * and both insert, and the register would then carry two open terms for one
 * chair with no way to say which the association meant.
 */
export async function lockBoardPositions(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-position:${personId}`}))`;
}

/**
 * Held while the holders of one system role are counted and changed.
 *
 * Keyed on the role rather than on the person, which is the whole point: the
 * lockout guard counts the administrators of the instance, so two revokes for
 * two different people have to wait for each other. Locked per person they
 * would take two different locks, each read two administrators, and each remove
 * one - and the instance would have none.
 */
export async function lockSystemRole(
  tx: Prisma.TransactionClient,
  role: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`system-role:${role}`}))`;
}

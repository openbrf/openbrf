import type { Prisma } from "../generated/prisma/client";

/**
 * The locks a fee write takes before it decides whether it may write.
 *
 * Both invariants this module keeps are derived from a set of rows, and both are
 * checked by reading the set and then writing. Two rates for one apartment and
 * one kind must never cover the same day; two notification runs must never cover
 * the same month. At READ COMMITTED - the isolation everything in this
 * application runs at - two requests arriving together both read the set as it
 * was, both find nothing in the way, and both write. The household is then
 * billed twice for the same months, on a notice whose amount is frozen on the
 * row.
 *
 * An advisory lock rather than a constraint, for the reason
 * `retention/legal-hold-lock.ts` and `registers/residency-lock.ts` give: the
 * invariant is about ranges across rows, and no single row carries it. A range
 * exclusion would need a database extension this project does not install, for
 * a contention it never has - rates are recorded a few times a year and a period
 * is issued once a quarter. Serialising the two writers that can collide costs
 * one of them a short wait and nothing else.
 *
 * Held here rather than beside either writer because a lock only works if every
 * writer spells the key the same way. A second spelling would be two locks that
 * never meet, which reads as serialised and is not.
 *
 * Taken for the transaction, so the commit or the rollback releases it with
 * nothing left to remember to unlock. The key is namespaced and hashed to the
 * int4 the lock space is addressed in; a collision costs the loser a short wait.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */

/**
 * The lock recording a rate takes for one apartment and one kind.
 *
 * Per apartment and kind rather than per apartment, because rates of different
 * kinds never constrain each other: a parking space can be recorded while the
 * annual fee is.
 */
export async function lockFeeRates(
  tx: Prisma.TransactionClient,
  apartmentId: string,
  kind: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-rates:${apartmentId}:${kind}`}))`;
}

/**
 * The lock issuing a period takes, and removing a rate takes too.
 *
 * One key for the whole instance, because the overlap it guards is between any
 * two runs whatever their periods are. Removing a rate takes it as well: the
 * removal asks whether a run has already billed the rate, and a run issued
 * between that question and the delete would bill a rate that then no longer
 * exists.
 */
export async function lockFeeNotifications(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"fee-notifications"}))`;
}

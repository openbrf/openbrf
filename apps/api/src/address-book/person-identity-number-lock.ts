import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it writes a person's personal identity
 * number, or decides from the persons who already have one.
 *
 * The import apply enters a row as a new person only when the register holds
 * nobody with the row's number, and it reads that inside the chunk's
 * transaction. The row that would change the answer can commit after the read
 * and before the chunk does - the board adding the same person from the
 * address book while the chunk runs. The register would then hold two persons
 * for one human being, and a data subject access report or an erasure asked
 * for by person would find one of the two and miss the other.
 *
 * An advisory lock rather than a constraint, because
 * `Person.personalIdentityNumberIndex` is not unique: the address book enters a
 * person without asking whether the number is already held, and the import
 * treats a number two persons share as a question for the board rather than a
 * fault. A unique index would change both, and refuse to migrate a register
 * that already holds such a pair. What has to be serialised here is the match
 * against the write, not the value.
 *
 * Keyed by the blind index rather than by the number, so the plaintext never
 * reaches the lock space or `pg_locks`. Every writer of
 * `Person.personalIdentityNumberIndex` takes it before the write, and the
 * import takes it before the match, so the match either sees a person
 * committed with the number or finishes before that person exists. Clearing a
 * number, as an erasure does, takes nothing: a row losing its number cannot
 * make a match miss it.
 *
 * Taken after the apartment's residency lock and the person email lock, and
 * before the legal hold and the transition keys. The import takes the
 * apartment's key first, as `lockApartmentResidencies` requires, then the
 * email keys, and then goes on to the transition keys; the address book takes
 * the email key and then this one. Taking it between the email and the
 * transition keys is the order both already keep.
 *
 * The key is namespaced and hashed to the int4 the lock space is addressed in.
 * A collision between two numbers costs one of them a short wait and nothing
 * else.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockPersonIdentityNumber(
  tx: Prisma.TransactionClient,
  identityNumberIndex: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`person-identity-number:${identityNumberIndex}`}))`;
}

/**
 * Takes the identity number lock for several numbers, in an order every caller
 * agrees on, for the reason `lockResidencyTransitionsInOrder` gives: an import
 * chunk writes many persons at once, and two transactions taking the same pair
 * in opposite orders would deadlock.
 */
export async function lockPersonIdentityNumbersInOrder(
  tx: Prisma.TransactionClient,
  identityNumberIndexes: Iterable<string>,
): Promise<void> {
  for (const identityNumberIndex of [
    ...new Set(identityNumberIndexes),
  ].sort()) {
    await lockPersonIdentityNumber(tx, identityNumberIndex);
  }
}

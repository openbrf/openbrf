import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it writes a person's email address, or
 * decides from the persons who already have one.
 *
 * The board's approval of a sign-up request matches the applicant to the
 * register by address: a person already there is linked rather than entered a
 * second time, and an address two persons share is refused. That decision is a
 * read, and the row that would change its answer can commit after it - the
 * board adding the same person from the address book while the approval runs.
 * The approval would then enter a second person for one human being, and a data
 * subject access report or an erasure asked for by person would find one of the
 * two and miss the other.
 *
 * An advisory lock rather than a constraint, because `Person.emailIndex` is not
 * unique and cannot be: a household can share one address, and the register
 * holds a person for each member of it. What has to be serialised is the match
 * against the write, not the value.
 *
 * Keyed by the person-scoped blind index rather than by the address, so the
 * plaintext never reaches the lock space or `pg_locks`. Every writer of
 * `Person.emailIndex` takes it before the write, and the approval takes it
 * before the match, so the match either sees a person committed with the
 * address or finishes before that person exists. Clearing an address, as an
 * erasure does, takes nothing: a row losing its address cannot make a match
 * miss it.
 *
 * Taken after the apartment's residency lock and before every other key: the
 * person identity number key, the legal hold and the transition keys. The
 * approval and the import both take the apartment's key before anything else,
 * as `lockApartmentResidencies` requires, and then go on to the transition
 * keys; taking this one between the two is the order both already keep. The
 * address book and the import take `lockPersonIdentityNumber` after it.
 *
 * The key is namespaced and hashed to the int4 the lock space is addressed in.
 * A collision between two addresses costs one of them a short wait and nothing
 * else.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockPersonEmail(
  tx: Prisma.TransactionClient,
  emailIndex: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`person-email:${emailIndex}`}))`;
}

/**
 * Takes the email lock for several addresses, in an order every caller agrees
 * on, for the reason `lockResidencyTransitionsInOrder` gives: an import chunk
 * writes many persons at once, and two transactions taking the same pair in
 * opposite orders would deadlock.
 */
export async function lockPersonEmailsInOrder(
  tx: Prisma.TransactionClient,
  emailIndexes: Iterable<string>,
): Promise<void> {
  for (const emailIndex of [...new Set(emailIndexes)].sort()) {
    await lockPersonEmail(tx, emailIndex);
  }
}

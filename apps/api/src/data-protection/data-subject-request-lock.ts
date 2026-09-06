import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it changes what one person has asked for.
 *
 * Three writers share one set of invariants over a person's requests: recording
 * refuses a second open request of a kind, deciding turns a grant into the
 * dated flag on the person that the mailers and the purges read, and closing
 * clears that flag when the request being closed was the last one holding it.
 * Each of those is a decision derived from a set of rows, taken by reading the
 * set and then writing. At READ COMMITTED the other two can commit in the gap.
 *
 * What that costs, concretely. Two recordings of the same kind arriving
 * together both read no open request and both create one, so "granted" stops
 * being a question with one answer. A close counting the remaining grants while
 * a decision is committing one clears `processingRestrictedAt` off a person who
 * has just been granted a restriction - and art. 18(2) is then not being
 * honoured for somebody the record says asked for it.
 *
 * An advisory lock for the reason `legal-hold-lock.ts` gives: the invariant is
 * derived from a set and no row carries it, so no constraint can state it.
 *
 * Held here rather than beside any one writer because the lock only works if
 * every writer uses the same key, and taken first where a transaction takes
 * more than one lock, so the three writers cannot deadlock against the hold and
 * residency locks a decision also needs.
 */
export async function lockDataSubjectRequests(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`data-subject-request:${personId}`}))`;
}

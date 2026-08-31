import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it claims a place at one date.
 *
 * ## Why capacity needs one and a double booking does not
 *
 * The booking module refuses a double booking with a partial unique index and no
 * lock at all: one live booking per resource and start time is a statement about
 * a single row, so Postgres can hold it. Capacity is not that. "At most twenty
 * standing sign-ups for this date" is a statement about a set of rows measured
 * against a number stored on another table - `event.capacity`, which the board
 * may change - and no unique index can express it. That is precisely the case
 * `lockApartmentBookings` in `bookings/booking-lock.ts` was written for, and its
 * argument holds here word for word: the count is read before the row that would
 * change its answer exists, so at READ COMMITTED two people claiming the
 * twentieth place would each count nineteen and both be let through.
 *
 * Nothing else closes that gap. A single statement carrying the count in its own
 * WHERE clause would not either: a statement at READ COMMITTED sees one snapshot,
 * taken before it started, so a subquery counting rows cannot see a claim that
 * committed while the statement was waiting. The count has to be taken in a
 * statement that begins after the competing transaction has finished, which is
 * what waiting for this lock guarantees and what makes the claim behind it
 * decisive rather than hopeful.
 *
 * ## What it costs
 *
 * People claiming places at the same date take their places one at a time.
 * Claims on different dates never wait for each other, because the key is the
 * occurrence - so a cleaning day filling up does not slow the general meeting
 * down, and twenty households signing up for twenty different dates run
 * concurrently.
 *
 * The key is namespaced and hashed to the int4 the advisory lock space is
 * addressed in, and the lock is released by the commit or the rollback with
 * nothing left to remember to unlock. A collision between two keys costs one of
 * them a short wait and nothing else.
 *
 * Held in a file of its own rather than beside its caller for the reason
 * `retention/legal-hold-lock.ts` gives: the lock only works if every writer uses
 * the same key, and a second spelling of this string would be two locks that
 * never meet - which is worse than no lock at all, because it reads as
 * serialised and is not.
 *
 * Run through `$executeRaw` rather than `$queryRaw` because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockOccurrenceSignups(
  tx: Prisma.TransactionClient,
  occurrenceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`event-occurrence-signups:${occurrenceId}`}))`;
}

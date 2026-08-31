import type { Prisma } from "../generated/prisma/client";

/**
 * The two locks a booking transaction takes before it decides anything.
 *
 * Neither is what refuses a double booking. That is the partial unique index on
 * (resourceId, startsAt), and it works without any of this: two residents
 * claiming the same laundry hour in the same instant are sorted out by Postgres
 * whether or not a lock is held. These cover the two invariants no single row
 * carries, which is exactly the case `registers/residency-lock.ts` makes for
 * doing it this way.
 *
 * The key is namespaced and hashed to the int4 the advisory lock space is
 * addressed in, and the lock is released by the commit or the rollback with
 * nothing left to remember to unlock. A collision between two keys costs one of
 * them a short wait and nothing else.
 *
 * Run through `$executeRaw` rather than `$queryRaw` because the lock function
 * returns void, which the client has no column type for.
 *
 * ## Order
 *
 * The apartment lock is always taken first and the resource lock second.
 * Deadlock needs two transactions disagreeing about the order of the same pair,
 * and a transaction that has already taken its apartment lock never waits for
 * another apartment - so one order, stated here and taken nowhere else, is
 * enough.
 */

/**
 * The lock a transaction takes before it counts what an apartment already
 * holds.
 *
 * A quota is not a column. It is derived at write time from the bookings the
 * apartment holds, which is what makes joint holders of one apartment share it
 * without a flag anybody has to keep in step - and it means the count is read
 * before the row that would change its answer exists. Two members of one
 * household booking at the same instant would each count the other's booking as
 * absent and both would be let through, so a household with three a week could
 * end up holding four.
 *
 * No unique index can state it: the invariant is over a set of rows and a
 * number stored on a different table. So it is a lock, and it is keyed on the
 * apartment because that is the unit the quota is counted for.
 *
 * The cost is that one household books one at a time, which is not a cost.
 * Bookings by different households never wait for each other, which is what
 * leaves the partial unique index as the thing that decides a race for the same
 * hour.
 */
export async function lockApartmentBookings(
  tx: Prisma.TransactionClient,
  apartmentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking-apartment:${apartmentId}`}))`;
}

/**
 * The lock a transaction takes before it claims a range of nights.
 *
 * For a resource booked a night at a time, one booking spans check-in to
 * check-out as a single row, so the partial unique index - which is over the
 * start time - cannot see that the 10th to the 12th and the 11th to the 13th
 * are the same guest apartment on the 11th. Two overlapping ranges have
 * different start times and the index admits both.
 *
 * So an overlap is refused by reading the resource's live bookings and
 * comparing, and that read has the same problem the quota count has: it is
 * taken before the row that would change its answer exists. This lock is what
 * makes the read decisive.
 *
 * Taken only for that mode. A resource booked in time slots or by the whole day
 * puts one booking on one slot, where the index states the invariant exactly
 * and a lock would serialise the whole house's laundry for nothing.
 */
export async function lockResourceBookings(
  tx: Prisma.TransactionClient,
  resourceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking-resource:${resourceId}`}))`;
}

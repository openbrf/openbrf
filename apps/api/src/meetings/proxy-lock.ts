import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it decides whether a member already has a
 * proxy holder at a meeting.
 *
 * EFL 6 kap. 4 § forsta stycket allows a member no more than one proxy holder,
 * and that rule is over the authorisations standing at any moment rather than
 * over any single row: a member's authorisations are one row per proxy holder,
 * with a withdrawal date on the ones that no longer stand. No row carries the
 * invariant, so no unique index can state it - not even a partial one, since the
 * schema this table is generated from can declare neither `WHERE` on an index
 * nor `NULLS NOT DISTINCT`.
 *
 * That leaves a read before a write, which is a race unless something serialises
 * it. Two board members registering different proxy holders for one member at
 * once each read no standing authorisation, and each writes one: the unique key
 * includes the proxy holder, so neither insert collides, and the member ends the
 * meeting with two people entitled to cast their single vote. The voting
 * register would then pick one of them, which is a decision no rule in this
 * platform made.
 *
 * An advisory lock rather than a serializable transaction, on the precedent
 * `residency-lock.ts` sets for the same shape of problem: it is one lock, taken
 * before anything is read, released by the commit or the rollback, and it costs
 * a colliding writer a short wait rather than a retry loop the caller has to
 * write.
 *
 * The key is namespaced by the meeting as well as the member, so two meetings
 * being prepared at once do not queue behind each other. It is hashed to the
 * int4 the lock space is addressed in; a collision between two members costs one
 * of them a wait and nothing else.
 *
 * Held in its own module for the reason the residency lock is: the lock works
 * only while every writer uses the same key, and a second spelling of this
 * string would be two locks that never meet.
 *
 * Run through `$executeRaw` rather than `$queryRaw` because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockProxyAuthorisations(
  tx: Prisma.TransactionClient,
  meetingId: string,
  memberPersonId: string,
): Promise<void> {
  const key = `meeting-proxy:${meetingId}:${memberPersonId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

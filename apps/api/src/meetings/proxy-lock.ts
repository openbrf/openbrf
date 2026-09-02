import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it decides anything about the proxy
 * authorisations standing at a meeting.
 *
 * Two rules are read before they are written and neither can be an index.
 *
 * A member may have no more than one proxy holder (EFL 6 kap. 4 § forsta
 * stycket). A member's authorisations are one row per proxy holder, with a
 * withdrawal date on the ones that no longer stand, so the rule is over the rows
 * that stand at any moment rather than over any single row - and the schema this
 * table is generated from can declare neither a `WHERE` on an index nor
 * `NULLS NOT DISTINCT`.
 *
 * Nobody may represent more than one member unless the bylaws determine
 * otherwise (BRL 9 kap. 14 § 4). That one is a count of a proxy holder's
 * standing authorisations against a setting, which no constraint can express at
 * all.
 *
 * ## Why one key for the meeting, and not one per person
 *
 * The two rules are keyed on different people - the first on the member, the
 * second on the proxy holder - so a lock narrow enough to name one of them
 * leaves the other racing. Two registrations naming different members for one
 * proxy holder would take different member keys, both read a count below the
 * limit, and both write: the holder would leave the meeting carrying more
 * members than the bylaws allow.
 *
 * Two locks, one per rule, would deadlock. One person can be a member at a
 * meeting and somebody else's proxy holder at the same meeting, so two
 * transactions can want the same pair of keys with the roles swapped, and
 * PostgreSQL resolves that cycle by killing one of them. Ordering the keys would
 * work and is what `residency-lock.ts` does for a set of persons in one
 * namespace; here the keys are in two namespaces with a person able to appear in
 * both, so the order would have to be defined across them, which is a rule to
 * get wrong for no gain.
 *
 * So the key is the meeting. Registering a proxy is a board action a handful of
 * times before one meeting, the transaction it serialises is short, and two
 * meetings being prepared at once do not queue behind each other.
 *
 * An advisory lock rather than a serializable transaction, on the precedent
 * `residency-lock.ts` sets: it is taken before anything is read, released by the
 * commit or the rollback, and it costs a colliding writer a short wait rather
 * than a retry loop every caller has to write.
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
): Promise<void> {
  const key = `meeting-proxy:${meetingId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it decides anything about the matters a
 * general meeting has been, or is about to be, summoned to deal with.
 *
 * One rule, read before it is written, and no constraint can state it. Issuing
 * the notice settles which matters the meeting deals with: EFL 6 kap. 22 § has
 * the notice state them clearly, 6 kap. 15 § gives a member the right to have
 * their item taken up in it, and 6 kap. 25 § leaves the meeting unable to
 * decide a matter the notice did not take up without the consent of every
 * member the failure affects. Three writers therefore read whether a notice
 * exists and then write on the answer: issuing the notice, replacing the
 * agenda, and linking a motion to the meeting or taking that link back.
 *
 * Everything runs at READ COMMITTED, where each of those reads sees its own
 * snapshot. Being inside the transaction that does the write is not the
 * guarantee: a notice committing after the read and before the write is
 * invisible to the reader, and the write lands. An item would be attached to a
 * meeting whose notice had already frozen the agenda, or the notice would
 * summon the members to a list a rewrite replaced a moment later. Neither
 * writer collides with the other in the database, because they touch different
 * tables - the notice is one row, the agenda is another table, and the link is
 * a column on the motion - so nothing refuses either of them and both outcomes
 * are silent.
 *
 * ## Why the key is the meeting
 *
 * The rule is about one meeting's matters and every writer names that meeting,
 * so the meeting is the narrowest key that covers all three. Anything narrower
 * would not: a key on the motion would let a notice and a link take different
 * keys, which is the race itself.
 *
 * Issuing a notice and setting an agenda are board actions a handful of times
 * before one meeting, the transactions this serialises are short, and two
 * meetings being prepared at once do not queue behind each other.
 *
 * ## Why not the proxy key
 *
 * `proxy-lock.ts` locks the same meeting under `meeting-proxy:`, and this is a
 * second key rather than a reuse of that one. The two rules share nothing: who
 * may exercise a member's vote is decided at the door and has no bearing on
 * which matters were summoned. One key for both would queue a board issuing a
 * notice behind a board registering proxy authorisations one at a time, which
 * is unrelated work waiting on unrelated work.
 *
 * An advisory lock rather than a serializable transaction, on the precedent
 * `residency-lock.ts` and `proxy-lock.ts` set: it is taken before anything is
 * read, released by the commit or the rollback, and it costs a colliding writer
 * a short wait rather than a retry loop every caller has to write.
 *
 * Held in its own module for the reason those two are: the lock works only
 * while every writer uses the same key, and a second spelling of this string
 * would be two locks that never meet. That is why `MotionService` imports this
 * across a module boundary rather than spelling the key for itself.
 *
 * Run through `$executeRaw` rather than `$queryRaw` because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockMeetingAgenda(
  tx: Prisma.TransactionClient,
  meetingId: string,
): Promise<void> {
  const key = `meeting-agenda:${meetingId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * Takes the agenda lock for several meetings, in an order every caller agrees
 * on.
 *
 * Moving a motion decides about two agendas - the one it leaves and the one it
 * joins - so that writer holds two keys at once. Two moves in opposite
 * directions between the same pair of meetings would take them in opposite
 * orders, which is a cycle PostgreSQL resolves by killing one of the
 * transactions. Sorting the identifiers removes it, on `residency-lock.ts`'s
 * precedent: it takes two transactions disagreeing about the order of the same
 * pair to make a cycle.
 *
 * Deduplicated, because a motion may be written to the meeting it is already
 * on, and sorted here rather than at the call site so the order is a property
 * of taking the locks rather than something each caller has to remember.
 */
export async function lockMeetingAgendasInOrder(
  tx: Prisma.TransactionClient,
  meetingIds: Iterable<string>,
): Promise<void> {
  for (const meetingId of [...new Set(meetingIds)].sort()) {
    await lockMeetingAgenda(tx, meetingId);
  }
}

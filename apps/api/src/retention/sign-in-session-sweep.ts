import type { PrismaService } from "../database/prisma.service";
import { withheldPersonIds } from "./withheld-persons";

/**
 * Deletes the sign-in sessions that have ended.
 *
 * A session lasts thirty days from its last renewal, and the sign-in library
 * deletes one only when it is signed out of, or when it is presented after it
 * has ended. A browser nobody opens again presents nothing, so without this its
 * row would stay until the person's own purge took the account - for as long as
 * they live here. What stays on it once it has ended is when somebody signed in
 * and from where: the IP address and the name the browser gave itself, held for
 * a purpose that has ended, which is what GDPR art. 5(1)(e) reaches. The record
 * of processing says an ended session is deleted the following night, and this
 * is what makes that sentence true.
 *
 * It rides the service-data purge's own minute rather than taking one of its
 * own, for the reason the connected-app token sweep beside it does: one delete
 * with no person loop behind it, and two jobs waking together on one small
 * connection pool gain nothing. It writes no audit entry, because nothing was
 * decided about anybody - a session that has ended has ended whoever it was
 * issued for.
 *
 * ## What it deliberately does not delete
 *
 * The sessions of a person under a standing legal hold or restriction. Unlike a
 * token, a session is a record of access and not only a credential, and a hold
 * and a restriction stop every purge for the person they stand for
 * (`withheld-persons.ts`); the access report tells a person under a hold
 * exactly that. So an ended session of theirs stays until the hold is released
 * or the restriction lifted, and goes on the first night after.
 *
 * The tokens issued to a connected app while signed in with a session. Both
 * kinds are detached from the session rather than deleted with it, because a
 * connected app outlives the browser session the person consented from.
 *
 * It does not read granted erasure requests: an erasure takes the account, and
 * every session with it, in the service-data purge itself. So the walk that
 * keeps the erasure jobs in order does not see this as one of them.
 *
 * @param now The moment to judge the end at, passed in so a run can be driven
 *   rather than waited for.
 * @returns How many sessions it deleted.
 */
export async function sweepExpiredSignInSessions(
  prisma: PrismaService,
  now: Date,
): Promise<number> {
  const withheld = await withheldPersonIds(prisma);
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lte: now }, user: { personId: { notIn: withheld } } },
  });
  return count;
}

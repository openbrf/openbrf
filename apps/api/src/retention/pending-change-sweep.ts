import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { lockLegalHold } from "./legal-hold-lock";
import { isPersonWithheld } from "./withheld-persons";

/**
 * Deletes the pending changes whose expiry has passed (ADR 0039).
 *
 * A pending change past its expiry can no longer be confirmed or seen: every
 * read and every act in `PendingChangeService` is keyed on the expiry as well
 * as the person, so it stopped waiting at that instant whether or not this has
 * run. What is left on the row is the input, which can name a resident, held
 * for a purpose that has ended - the GDPR art. 5(1)(e) case the session sweep
 * beside it answers for sessions. The record of processing says a pending
 * change is deleted the night after it expires, and this makes that true.
 *
 * It rides the service-data purge's own minute, after the token and session
 * sweeps, for their reason: jobs waking together on one small connection pool
 * gain nothing.
 *
 * Each deletion writes PENDING_CHANGE_EXPIRED, with no actor and the proposer
 * as the target, so that the end of a proposal is on the proposer's access
 * report as its beginning is. The entry names the action and never the input.
 *
 * A change a confirmation handed to its action and then could not record
 * (`PendingChangeService.confirm`) stopped waiting at that moment and is
 * swept here too. Its entry says `dispatched`, because it did not simply lapse:
 * its action ran, or tried to, and the action's own entry naming the pending
 * change says what came of it.
 *
 * ## What it deliberately does not delete
 *
 * The pending changes of a person under a standing legal hold or restriction,
 * which stop every purge for the person they stand for (`withheld-persons.ts`).
 * Such a change stays past its expiry, unconfirmable and unseen, until the hold
 * is released or the restriction lifted, and goes on the first night after.
 *
 * ## One person at a time, under the legal hold key
 *
 * For the reason `sign-in-session-sweep.ts` gives: a hold placed while the
 * sweep runs either commits before the read, and the changes stay, or waits
 * for the delete to commit.
 *
 * @param now The moment to judge expiry at, passed in so a run can be driven
 *   rather than waited for.
 * @returns How many pending changes it deleted.
 */
export async function sweepExpiredPendingChanges(
  prisma: PrismaService,
  audit: AuditLogService,
  now: Date,
): Promise<number> {
  /*
   * Whose changes have expired, read without a lock. The scan only says where
   * to look; the transaction below decides.
   */
  const proposers = await prisma.pendingChange.findMany({
    where: { expiresAt: { lte: now } },
    select: { proposedByPersonId: true },
    distinct: ["proposedByPersonId"],
  });

  let swept = 0;
  for (const { proposedByPersonId: personId } of proposers) {
    swept += await prisma.$transaction(async (tx) => {
      await lockLegalHold(tx, personId);
      if (await isPersonWithheld(tx, personId)) {
        return 0;
      }
      const expired = await tx.pendingChange.findMany({
        where: { proposedByPersonId: personId, expiresAt: { lte: now } },
        select: { id: true, actionName: true, dispatchedAt: true },
      });
      await tx.pendingChange.deleteMany({
        where: { id: { in: expired.map((change) => change.id) } },
      });
      for (const change of expired) {
        await audit.record(
          {
            action: "PENDING_CHANGE_EXPIRED",
            channel: "SYSTEM",
            actorPersonId: null,
            targetPersonId: personId,
            targetKind: "pendingChange",
            targetId: change.id,
            context:
              change.dispatchedAt === null
                ? { action: change.actionName }
                : { action: change.actionName, dispatched: true },
          },
          tx,
        );
      }
      return expired.length;
    });
  }
  return swept;
}

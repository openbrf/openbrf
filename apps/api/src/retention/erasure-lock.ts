import type { Prisma } from "../generated/prisma/client";
import { SystemRoleType } from "../generated/prisma/enums";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { lockBoardPositions, lockSystemRole } from "../roles/role-lock";

/**
 * The locks a purge takes before it asks whether a person's granted erasure may
 * be carried out ({@link isErasureInForce}), and holds while it erases.
 *
 * Four things refuse an erasure: a residency still running, a board seat still
 * held, a system role and a plugin access. The last three are the ties of
 * `standing-ties.ts`, and a tie added there has its writer's key taken here.
 * Each is a row its own writer adds, and at READ
 * COMMITTED - the isolation everything in this application runs at - a move-in,
 * an election, a role grant or an access grant committing between the purge's
 * read and its delete would leave the purge erasing a person who is a
 * resident, a board member, an administrator or a plugin's served person
 * again. The service-data purge would then refuse
 * the same request that night, but the rows another job erased are gone, and
 * they were the rows of somebody the association still has a lawful reason to
 * keep. Taking each writer's own key orders the two: the writer either commits
 * first and the purge sees it, or waits for the purge to commit.
 *
 * The keys are the ones the writers already take: the person's residency
 * transition key (MoveService, the import, and PluginAccessService's grant,
 * which takes it because a grant is refused to anybody with a residency on
 * record), the person's board seat key
 * (BoardPositionService) and the key of every system role (SystemRoleService
 * locks a role, not a person, because its lockout guard counts a role's
 * holders). Taken after the person's legal hold key, or the hold registry's,
 * and in this order. No writer of a seat or a role takes a hold or residency key
 * after its own, and the role keys are taken in one sorted order, so a purge
 * cannot be half of a deadlock with any of them.
 */
export async function lockErasureEligibility(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await lockResidencyTransitions(tx, personId);
  await lockBoardPositions(tx, personId);
  for (const role of Object.values(SystemRoleType).sort()) {
    await lockSystemRole(tx, role);
  }
}

import type { Prisma } from "../generated/prisma/client";
import { SystemRoleType } from "../generated/prisma/enums";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { lockBoardPositions, lockSystemRole } from "../roles/role-lock";

/**
 * The locks a purge takes before it asks whether a person's granted erasure may
 * be carried out ({@link isErasureInForce}), and holds while it erases.
 *
 * Three things refuse an erasure: a residency still running, a board seat still
 * held and a system role. Each is a row its own writer adds, and at READ
 * COMMITTED - the isolation everything in this application runs at - a move-in,
 * an election or a role grant committing between the purge's read and its
 * delete would leave the purge erasing a person who is a resident, a board
 * member or an administrator again. The service-data purge would then refuse
 * the same request that night, but the rows another job erased are gone, and
 * they were the rows of somebody the association still has a lawful reason to
 * keep. Taking each writer's own key orders the two: the writer either commits
 * first and the purge sees it, or waits for the purge to commit.
 *
 * The keys are the ones the writers already take: the person's residency
 * transition key (MoveService, the import), the person's board seat key
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

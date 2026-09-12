import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a change to one charge takes before it reads the row it is about to
 * change.
 *
 * A correction is a read and then a write of the same row: the fields the board
 * left out are carried over from what was stored, and the audit entry names
 * which of them moved. Under READ COMMITTED two corrections arriving at once
 * both read the row as it was, and the later commit silently drops the earlier
 * one's changes while the log says both were made. A removal in the same window
 * is worse: the read finds the row, the update finds nothing, and the caller
 * meets a driver error rather than the refusal this module has a reason code
 * for.
 *
 * Taken the way `role-lock.ts` and `residency-lock.ts` take theirs: an advisory
 * lock held for the transaction, released by the commit or the rollback with
 * nothing left to remember to unlock. The key is namespaced and hashed to the
 * int4 the lock space is addressed in; a collision costs the loser a short wait
 * and nothing else.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockMemberCharge(
  tx: Prisma.TransactionClient,
  chargeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-charge:${chargeId}`}))`;
}

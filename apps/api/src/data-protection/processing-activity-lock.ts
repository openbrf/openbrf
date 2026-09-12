import type { Prisma } from "../generated/prisma/client";

/**
 * Serialises writes to one processing activity.
 *
 * `update` reads the row, decides which fields a payload actually changes by
 * comparing it against that row, and writes. A second save committing between
 * the read and the write leaves the comparison describing a row that is no
 * longer there: the write overwrites the newer fields, while the decision about
 * `updatedByPersonId` and the audit entry naming the changed fields both
 * describe the older one. Taken at the start of the transaction, before the
 * read, so the comparison and the write see the same row.
 */
export async function lockProcessingActivity(
  tx: Prisma.TransactionClient,
  activityId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`processing-activity:${activityId}`}))`;
}

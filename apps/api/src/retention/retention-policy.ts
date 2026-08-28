/**
 * The association's retention policy, read in one place.
 *
 * Beside {@link computePurgeDate} on purpose: the computation and the number it
 * is computed from are one decision. The purge date is a retention promise to a
 * moved-out person, and the board reads it from two paths - the register row and
 * the person panel - so a default that differed between them would state two
 * erasure dates for the same residency.
 */

import type { PrismaService } from "../database/prisma.service";

/**
 * What a fresh instance starts at, and what applies before the setup wizard has
 * written the association row.
 */
export const DEFAULT_RETENTION_DAYS_AFTER_MOVE_OUT = 365;

/** The association's retention policy in days, or the default when unset. */
export async function retentionDaysAfterMoveOut(
  prisma: PrismaService,
): Promise<number> {
  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { retentionDaysAfterMoveOut: true },
  });
  return (
    association?.retentionDaysAfterMoveOut ??
    DEFAULT_RETENTION_DAYS_AFTER_MOVE_OUT
  );
}

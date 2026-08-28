/**
 * Service-tier retention: when a moved-out person's operational data is erased.
 *
 * The two-tier model (plan section 4.2, decision 21) puts the statutory
 * archive - the member register, transfers, lien notes, the audit log - beyond
 * the reach of this date entirely. What the purge date governs is the service
 * tier: the account, the contact details, the operational residency data. The
 * cooperative keeps the statutory record because EFL 5 kap. requires it, and
 * erases the rest because GDPR requires that.
 *
 * The date is **derived, never stored**. That is the whole design: a board that
 * shortens the retention policy from 365 to 180 days has, by that act, moved
 * every pending purge date, and no recomputation job has to run for the
 * register to tell the truth. A stored copy would need one, and would be wrong
 * until it ran.
 *
 * Phase 1 computes and displays this date. The job that acts on it is phase 2.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The date service-tier data for a residency becomes erasable.
 *
 * @param movedOutOn The anchor: the day the residency ended. Null while the
 *   residency is current, which has no purge date at all rather than one far in
 *   the future.
 * @param retentionDaysAfterMoveOut The association's policy. A fresh instance
 *   starts at 365 days.
 * @returns The purge date, or null when there is nothing to purge yet.
 */
export function computePurgeDate(
  movedOutOn: Date | null,
  retentionDaysAfterMoveOut: number,
): Date | null {
  if (movedOutOn === null) {
    return null;
  }
  if (
    !Number.isFinite(retentionDaysAfterMoveOut) ||
    retentionDaysAfterMoveOut < 0
  ) {
    throw new RangeError(
      `Retention policy must be a non-negative number of days, got ${String(
        retentionDaysAfterMoveOut,
      )}.`,
    );
  }

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic.
  // Move-out dates are stored as @db.Date, so they arrive at UTC midnight, and
  // adding days in local time would shift the result across a Swedish daylight
  // saving boundary - a purge date landing a day early is an erasure a day
  // early.
  return new Date(
    movedOutOn.getTime() +
      Math.round(retentionDaysAfterMoveOut) * MILLISECONDS_PER_DAY,
  );
}

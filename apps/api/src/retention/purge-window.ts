/**
 * When a purge date has arrived, expressed as a date the database can compare.
 *
 * The inverse of {@link computePurgeDate}, and beside it for that reason. The
 * register screens ask "when will this residency's service data be erased",
 * which is a computation per row; the purge job asks the opposite question of
 * the whole table at once - "which residencies ended long enough ago" - and
 * that has to be one comparison in SQL rather than a date computed for every
 * person who ever lived here.
 *
 * The two must agree exactly. A cutoff a day early is an erasure a day early,
 * on data the register has been promising a later date for, so the agreement
 * is asserted rather than assumed: purge-window.spec.ts runs both functions
 * against each other.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The latest move-out date whose purge date has arrived.
 *
 * A residency that ended on or before this is erasable; one that ended after
 * it is not, and neither is one that has not ended at all.
 *
 * @param now The moment the job is running at, passed in so a test can drive
 *   the clock rather than wait for it.
 * @param retentionDaysAfterMoveOut The association's policy.
 */
export function purgeCutoff(
  now: Date,
  retentionDaysAfterMoveOut: number,
): Date {
  if (
    !Number.isFinite(retentionDaysAfterMoveOut) ||
    retentionDaysAfterMoveOut < 0
  ) {
    // The same refusal computePurgeDate makes, for the same reason: a policy
    // that is not a number of days would otherwise become a cutoff in the
    // future and erase data whose retention had not run out.
    throw new RangeError(
      `Retention policy must be a non-negative number of days, got ${String(
        retentionDaysAfterMoveOut,
      )}.`,
    );
  }

  return new Date(
    now.getTime() -
      Math.round(retentionDaysAfterMoveOut) * MILLISECONDS_PER_DAY,
  );
}

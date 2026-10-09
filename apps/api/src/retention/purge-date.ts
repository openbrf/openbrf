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

/** What the scheduled purge asks about a person before it acts on them. */
export interface PersonPurgeFacts {
  residencies: readonly { movedOutOn: Date | null }[];
  boardPositions: readonly { endedOn: Date | null }[];
  /** Granted system roles, however many. */
  systemRoles: number;
  /** A legal hold stands, or a restriction of processing does. */
  withheld: boolean;
}

/**
 * The date the scheduled purge erases a person's service data, or null while
 * something stands in its way.
 *
 * The purge acts on the person, not on one residency: it waits for the last
 * residency to end, and leaves a person alone while they hold a board seat or a
 * system role, or while a legal hold or a restriction stands. A date taken from
 * one residency's move-out promised an erasure that was not coming, for a
 * person who had moved to another apartment. The conditions are the ones
 * `purgeRefusal` applies to the scheduled run, and a change to one is a change
 * to the other.
 *
 * @param now Judges whether a board seat has ended.
 */
export function computePersonPurgeDate(
  person: PersonPurgeFacts,
  retentionDaysAfterMoveOut: number,
  now: Date,
): Date | null {
  if (
    person.withheld ||
    person.systemRoles > 0 ||
    person.boardPositions.some(
      (position) =>
        position.endedOn === null || position.endedOn.getTime() > now.getTime(),
    ) ||
    person.residencies.length === 0
  ) {
    return null;
  }

  let lastMoveOut: Date | null = null;
  for (const { movedOutOn } of person.residencies) {
    if (movedOutOn === null) {
      return null;
    }
    if (lastMoveOut === null || movedOutOn.getTime() > lastMoveOut.getTime()) {
      lastMoveOut = movedOutOn;
    }
  }
  return computePurgeDate(lastMoveOut, retentionDaysAfterMoveOut);
}

import {
  addLocalDays,
  dateColumnOf,
  localDayOfColumn,
} from "../bookings/stockholm-calendar";

/**
 * How long a closed subletting application is kept, and when the purge reaches
 * it.
 *
 * An application is service-tier personal data: it says which member wanted to
 * let their apartment, to when, and why, in their own words, and what the board
 * answered. The purpose it is held for is running the queue the board works
 * from, answering the applicant who asks what became of their request, and
 * standing as the association's own record of a consent it gave or refused -
 * and that last purpose does not end when the board answers. It ends a while
 * after the letting the consent was about is over.
 *
 * ## Two anchors, and why they are one condition
 *
 * The clock runs from the later of two dates: the day the application closed,
 * and the day the period applied for ended. Anchoring on the closing date alone
 * would erase the association's record of its own consent while the letting was
 * still running - a board asked in the third year of a five-year consent whether
 * it had ever agreed to it would find nothing. Anchoring on the period alone
 * would put a request withdrawn the day it was made on the clock of a period
 * that was never used.
 *
 * That "later of two" is what makes the two functions here look asymmetrical,
 * and they are not. {@link computeSubletPurgeDate} takes the maximum of the two
 * anchors and adds the window, which is a computation per row and what a data
 * subject access report states. {@link subletPurgeCutoffs} asks the opposite
 * question of the whole table at once, which has to be a comparison in SQL - and
 * `max(a, b) + w <= now` is exactly `a + w <= now and b + w <= now`, so the scan
 * is two comparisons joined by AND rather than an expression the database would
 * have to compute per row. `sublet-retention.spec.ts` runs the two against each
 * other rather than trusting that identity to look obvious.
 *
 * ## An open application is never purged
 *
 * There is no cutoff for a request still with the board, deliberately, on the
 * reading `motion-retention.ts` sets out: the association is processing it, so
 * the purpose it is held for has not ended, and GDPR art. 5.1 e asks for no
 * longer than necessary *for the purpose* rather than for a fixed span. An open
 * application older than the window is a queue nobody has worked, which is a
 * thing for the board to see rather than for a job to erase.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a closed subletting application is kept past its last anchor.
 *
 * Two years, and the number follows from what the record is for after the
 * letting ends. Letting an apartment in andra hand without the board's consent
 * is a ground on which the right of use is forfeited (BRL 7 kap. 18 § 2), so the
 * question this row answers - was there a consent, and what did it cover - is
 * one that surfaces after the fact rather than during. Two years past the end of
 * the letting clears the annual cycle in which such a dispute reaches a general
 * meeting, with room for one held late.
 *
 * A constant rather than a board setting, for the reason
 * `MOTION_RETENTION_DAYS` is one: the association's retention policy answers a
 * different question - how long a former resident's data is kept - and this
 * purpose ends on its own schedule whoever applied and whether or not they still
 * live here.
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone.
 */
export const SUBLET_RETENTION_DAYS = 730;

/**
 * The cutoffs a purge scan compares a row against.
 *
 * Both have to be met. See the module comment for why two comparisons joined by
 * AND are the same rule as one maximum.
 */
export interface SubletPurgeCutoffs {
  /** A closed application is in scope when its closing date is at or before this. */
  closedAtOrBefore: Date;
  /**
   * ...and when the period applied for ended on or before this day.
   *
   * A whole day, as a `@db.Date` column holds one: floored to the UTC day the
   * instant falls in, which changes nothing because the column being compared is
   * always midnight UTC of some date. Passing an instant instead would leave the
   * comparison depending on how the client renders a timestamp against a date
   * column.
   */
  periodEndedOnOrBefore: Date;
}

/**
 * The date an application becomes erasable, or null while it is still open.
 *
 * @param closedAt When the application stopped being open, whichever way it
 *   closed. Null while it is with the board, which has no purge date at all
 *   rather than one far in the future - see the module comment.
 * @param periodTo The last day of the period applied for, as the `@db.Date`
 *   column holds it.
 * @param retentionDays How long a closed application is kept past its last
 *   anchor.
 */
export function computeSubletPurgeDate(
  closedAt: Date | null,
  periodTo: Date,
  retentionDays: number = SUBLET_RETENTION_DAYS,
): Date | null {
  assertRetentionDays(retentionDays);

  if (closedAt === null) {
    return null;
  }

  const anchor = Math.max(closedAt.getTime(), endOfPeriod(periodTo).getTime());

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computePurgeDate and computeMotionPurgeDate do it:
  // adding days in Europe/Stockholm shifts the result by an hour across a
  // daylight saving boundary, and a purge date an hour early is still an erasure
  // before the date the report stated.
  return new Date(anchor + Math.round(retentionDays) * MILLISECONDS_PER_DAY);
}

/**
 * The two comparisons that select an erasable application.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait two years for it.
 * @param retentionDays How long a closed application is kept past its last
 *   anchor.
 */
export function subletPurgeCutoffs(
  now: Date,
  retentionDays: number = SUBLET_RETENTION_DAYS,
): SubletPurgeCutoffs {
  assertRetentionDays(retentionDays);

  const window = Math.round(retentionDays) * MILLISECONDS_PER_DAY;

  /*
   * One day further back than the closing cutoff, and the extra day is the
   * period's own last day. The letting is over when the day after its last one
   * begins, so `periodTo + 1 day + window <= now` is the condition - and stated
   * against the column itself that is `periodTo <= now - window - 1 day`.
   */
  const periodEnd = new Date(now.getTime() - window - MILLISECONDS_PER_DAY);

  return {
    closedAtOrBefore: new Date(now.getTime() - window),
    periodEndedOnOrBefore: dateColumnOf(localDayOfColumn(periodEnd)),
  };
}

/**
 * The instant a period is over: the start of the day after its last one.
 *
 * A date column carries no time, so the last day of a letting read back as
 * midnight UTC would put the anchor at the *beginning* of that day - a whole day
 * early, and an erasure a day before the date the access report stated is still
 * an erasure before it.
 */
function endOfPeriod(periodTo: Date): Date {
  return dateColumnOf(addLocalDays(localDayOfColumn(periodTo), 1));
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both exported functions need, for the reason
 * `purge-window.ts` gives: a window that is not a number would otherwise put the
 * cutoff in the future and erase applications whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Sublet retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

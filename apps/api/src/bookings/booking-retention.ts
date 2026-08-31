/**
 * How long a booking is kept, and when the purge reaches it.
 *
 * A booking is service-tier personal data: it says which person, in which
 * apartment, held which hour of the laundry room. The purpose it is held for is
 * running the calendar, and that purpose ends when the booking does. So the
 * retention clock is anchored on `endsAt` rather than on a move-out - somebody
 * who still lives here has no more use for last March's sauna hour than
 * somebody who has left, and the residency purge would never reach it at all
 * while they stayed.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends. {@link computeBookingPurgeDate} answers "when is this booking erased",
 * which is a computation per row and what a data subject access report states.
 * {@link bookingPurgeCutoff} asks the opposite question of the whole table at
 * once - "which bookings ended long enough ago" - which has to be one
 * comparison in SQL rather than a date computed for every booking ever made.
 * If the two disagree the product erases on a day other than the one it stated,
 * so `booking-retention.spec.ts` runs them against each other rather than
 * trusting the arithmetic to look symmetrical.
 *
 * The same shape as the service-tier residency purge (`retention/purge-date.ts`
 * and `retention/purge-window.ts`), and deliberately not the same number.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a finished booking is kept.
 *
 * A constant rather than a board setting, because it is not the same question
 * the association's retention policy answers. That policy is about a person
 * whose relationship with the cooperative has ended, and the board sets it
 * because the association is answerable for how long it keeps a former
 * resident's data. A booking's purpose ends the moment the booking does,
 * whoever made it and whether or not they still live here.
 *
 * A year is what makes the history usable while it is worth having: a board
 * looking at whether the guest apartment is worth keeping wants last summer to
 * compare against, and a resident disputing a quota refusal wants the week it
 * was counted from. After that it is a record of who used the sauna and when,
 * which the association has no reason to hold.
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone. If it ever becomes a board
 * setting it is read here and nothing else changes.
 */
export const BOOKING_RETENTION_DAYS = 365;

/**
 * The date a booking becomes erasable.
 *
 * @param endsAt When the booked period ended. The anchor, for the reason the
 *   module comment gives.
 * @param retentionDays How long a finished booking is kept.
 */
export function computeBookingPurgeDate(
  endsAt: Date,
  retentionDays: number = BOOKING_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computePurgeDate does it: adding days in Europe/
  // Stockholm shifts the result by an hour across a daylight saving boundary,
  // and a purge date an hour early is still an erasure before the date the
  // report stated.
  return new Date(
    endsAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest end time whose purge date has arrived.
 *
 * A booking that ended on or before this is erasable; one that ended after it
 * is not.
 *
 * @param now The moment the job is running at, passed in so a test can drive
 *   the clock rather than wait a year for it.
 * @param retentionDays How long a finished booking is kept.
 */
export function bookingPurgeCutoff(
  now: Date,
  retentionDays: number = BOOKING_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  return new Date(
    now.getTime() - Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both functions need, for the reason purge-window.ts gives:
 * a window that is not a number would otherwise put the cutoff in the future
 * and erase bookings whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Booking retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

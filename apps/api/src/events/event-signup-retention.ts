/**
 * How long a sign-up is kept, and when the purge reaches it.
 *
 * A sign-up (anmalan) is service-tier personal data: it says that a named person
 * intended to be at one of the association's dates. The purpose it is held for is
 * running that date - knowing how many places are gone, and having a roll-call on
 * the morning - and that purpose ends when the date does. So the retention clock
 * is anchored on the occurrence's `endsAt` rather than on a move-out: somebody
 * who still lives here has no more use for last April's cleaning day than
 * somebody who has left, and the residency purge would never reach it at all
 * while they stayed.
 *
 * Anchored on the occurrence's end and not on the withdrawal date, for the same
 * reason. Standing down does not shorten the window and does not lengthen it: the
 * row is about a date, and it is the date that decides when the association has
 * no further use for it. A withdrawal recorded a year before the occurrence would
 * otherwise be erased before the event it is about had happened, which would
 * leave the roll-call unable to say why somebody who signed up is not on it.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends, exactly as `bookings/booking-retention.ts` is.
 * {@link computeEventSignupPurgeDate} answers "when is this sign-up erased",
 * which is a computation per row and what a data subject access report states.
 * {@link eventSignupPurgeCutoff} asks the opposite question of the whole table at
 * once - "which sign-ups are for dates that ended long enough ago" - which has to
 * be one comparison in SQL rather than a date computed for every sign-up ever
 * made. If the two disagree the product erases on a day other than the one it
 * stated, so `event-signup-retention.spec.ts` runs them against each other rather
 * than trusting the arithmetic to look symmetrical.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a sign-up is kept after the date it was for.
 *
 * A constant rather than a board setting, on the argument
 * BOOKING_RETENTION_DAYS makes: the association's retention policy is about a
 * person whose relationship with the cooperative has ended, and this window is
 * about a date that has passed, whoever signed up and whether or not they still
 * live here.
 *
 * A year, because a year is one full turn of the association's own calendar.
 * A board arranging next spring's cleaning day wants last spring's to compare
 * against - how many put their name down, how many of the places went - and a
 * resident disputing a place they were refused wants the date it was refused on.
 * After that it is a record of who turned up to what, which the association has
 * no reason to hold. The same number the booking window uses, arrived at from the
 * same question rather than copied: both are "one comparable cycle of the thing
 * this data was collected to run".
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone.
 */
export const EVENT_SIGNUP_RETENTION_DAYS = 365;

/**
 * The date a sign-up becomes erasable.
 *
 * @param occurrenceEndsAt When the date signed up to ended. The anchor, for the
 *   reason the module comment gives.
 * @param retentionDays How long a sign-up is kept after that.
 */
export function computeEventSignupPurgeDate(
  occurrenceEndsAt: Date,
  retentionDays: number = EVENT_SIGNUP_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computeBookingPurgeDate does it: adding days in
  // Europe/Stockholm shifts the result by an hour across a daylight saving
  // boundary, and a purge date an hour early is still an erasure before the date
  // the report stated.
  return new Date(
    occurrenceEndsAt.getTime() +
      Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest occurrence end whose purge date has arrived.
 *
 * A sign-up for a date that ended on or before this is erasable; one for a date
 * that ended after it is not.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait a year for it.
 * @param retentionDays How long a sign-up is kept after the date it was for.
 */
export function eventSignupPurgeCutoff(
  now: Date,
  retentionDays: number = EVENT_SIGNUP_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  return new Date(
    now.getTime() - Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both functions need, for the reason `purge-window.ts` gives: a
 * window that is not a number would otherwise put the cutoff in the future and
 * erase sign-ups whose retention had not run out - including ones for dates that
 * have not happened yet.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Event sign-up retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

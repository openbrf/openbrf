/**
 * How long a closed motion is kept, and when the purge reaches it.
 *
 * A motion is service-tier personal data: it says which member proposed what to
 * the association, in their own words. The purpose it is held for is running the
 * queue the board works from and answering the member who asks what became of
 * their item, and that purpose ends a while after the motion is closed - not
 * when the member moves out. So the clock is anchored on the closing date rather
 * than on a move-out, the way a booking's is anchored on the booked period:
 * someone who still lives here has no more use for a motion dealt with two
 * annual meetings ago than someone who has left, and the residency purge would
 * never reach it at all while they stayed.
 *
 * ## An open motion is never purged
 *
 * There is no cutoff for a motion still with the board, deliberately. The
 * association is processing it, so the purpose it is held for has not ended, and
 * GDPR art. 5.1 e asks for no longer than necessary *for the purpose* rather than
 * for a fixed span. An open motion older than the window is a queue nobody has
 * worked, which is a thing for the board to see rather than for a job to erase.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends, exactly as `bookings/booking-retention.ts` is.
 * {@link computeMotionPurgeDate} answers "when is this motion erased", which is a
 * computation per row and what a data subject access report states.
 * {@link motionPurgeCutoff} asks the opposite question of the whole table at once
 * - "which motions closed long enough ago" - which has to be one comparison in
 * SQL. If the two disagree the product erases on a day other than the one it
 * stated, so `motion-retention.spec.ts` runs them against each other rather than
 * trusting the arithmetic to look symmetrical.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a closed motion is kept.
 *
 * Two years, and the number follows from the annual cycle the thing lives in. A
 * motion is dealt with at one general meeting, and the meeting where a member
 * asks what came of it is the one after that - so the row has to outlive a full
 * year from its closing date, or the record is gone before the question is asked.
 * Two years clears that with room for a meeting held late, and stops well short
 * of being an archive: what the meeting *decided* is in the minutes, which live
 * in the document archive as association records and are not personal data held
 * on a retention clock at all. After two years this row is a member's name
 * against a proposal, kept for nothing.
 *
 * A constant rather than a board setting, for the reason
 * `BOOKING_RETENTION_DAYS` is one: the association's retention policy answers a
 * different question - how long a former resident's data is kept - and a motion's
 * purpose ends on its own schedule whoever submitted it and whether or not they
 * still live here.
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone.
 */
export const MOTION_RETENTION_DAYS = 730;

/**
 * The date a motion becomes erasable, or null while it is still open.
 *
 * @param closedAt When the motion stopped being open, whichever way it closed.
 *   Null while it is with the board, which has no purge date at all rather than
 *   one far in the future - see the module comment.
 * @param retentionDays How long a closed motion is kept.
 */
export function computeMotionPurgeDate(
  closedAt: Date | null,
  retentionDays: number = MOTION_RETENTION_DAYS,
): Date | null {
  assertRetentionDays(retentionDays);

  if (closedAt === null) {
    return null;
  }

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computePurgeDate and computeBookingPurgeDate do it:
  // adding days in Europe/Stockholm shifts the result by an hour across a
  // daylight saving boundary, and a purge date an hour early is still an erasure
  // before the date the report stated.
  return new Date(
    closedAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest closing time whose purge date has arrived.
 *
 * A motion closed on or before this is erasable; one closed after it is not, and
 * one that is still open is out of scope entirely - which the scan states as a
 * `closedAt: { not: null, lte: cutoff }` rather than relying on a comparison
 * against null.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait two years for it.
 * @param retentionDays How long a closed motion is kept.
 */
export function motionPurgeCutoff(
  now: Date,
  retentionDays: number = MOTION_RETENTION_DAYS,
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
 * erase motions whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Motion retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

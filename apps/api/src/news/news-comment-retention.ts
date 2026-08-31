/**
 * How long a comment on a news item is kept, and when the purge reaches it.
 *
 * A comment is service-tier personal data: it says which person wrote which
 * words under which notice. The purpose it is held for is the conversation
 * about that notice, and that conversation is over long before the person
 * leaves. So the clock is anchored on the comment's own `createdAt` rather than
 * on a move-out - somebody who still lives here has no more use for last
 * spring's exchange about the bicycle room than somebody who has left, and the
 * residency purge would never reach it at all while they stayed.
 *
 * The anchor is the comment rather than the news item, and that is a decision
 * rather than the only reading. Anchoring on the item would keep a whole thread
 * for the same span and erase it together, which reads tidier; it would also
 * mean that a comment written on a two-year-old notice was erasable the moment
 * it was written. Each comment is its own piece of personal data held for its
 * own purpose, so each one carries its own window.
 *
 * A hidden comment is on the same clock as one that stands. Moderation is not a
 * reason to keep somebody's words longer: the audit log records who hid what and
 * when, and that record is what outlives the row.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends. {@link computeNewsCommentPurgeDate} answers "when is this comment
 * erased", which is a computation per row and what a data subject access report
 * states. {@link newsCommentPurgeCutoff} asks the opposite question of the whole
 * table at once - "which comments were written long enough ago" - which has to
 * be one comparison in SQL rather than a date computed for every comment ever
 * written. If the two disagree the product erases on a day other than the one it
 * stated, so `news-comment-retention.spec.ts` runs them against each other
 * rather than trusting the arithmetic to look symmetrical.
 *
 * The same shape as `bookings/booking-retention.ts`, and deliberately the same
 * number: both are service-tier records of one resident's use of the house, and
 * two different windows would be two answers to one question nobody asked.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a comment is kept after it was written.
 *
 * A constant rather than a board setting, for the reason the booking window is
 * one: the association's retention policy is about a person whose relationship
 * with the cooperative has ended, and the board sets it because the association
 * is answerable for how long it keeps a former resident's data. A comment's
 * purpose ends with the conversation it belongs to, whoever wrote it and whether
 * or not they still live here.
 *
 * A year is what makes a thread worth having while it is worth having: a board
 * asked the same question twice in a season wants last season's answers, and a
 * resident pointing at what was agreed under a notice wants the notice still to
 * carry it. After that it is a record of what one neighbour said about another,
 * which the association has no reason to hold.
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone.
 */
export const NEWS_COMMENT_RETENTION_DAYS = 365;

/**
 * The date a comment becomes erasable.
 *
 * @param writtenAt When the comment was written. The anchor, for the reason the
 *   module comment gives.
 * @param retentionDays How long a comment is kept.
 */
export function computeNewsCommentPurgeDate(
  writtenAt: Date,
  retentionDays: number = NEWS_COMMENT_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computePurgeDate and computeBookingPurgeDate do it:
  // adding days in Europe/Stockholm shifts the result by an hour across a
  // daylight saving boundary, and a purge date an hour early is still an
  // erasure before the date the report stated.
  return new Date(
    writtenAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest writing time whose purge date has arrived.
 *
 * A comment written on or before this is erasable; one written after it is not.
 *
 * @param now The moment the job is running at, passed in so a test can drive
 *   the clock rather than wait a year for it.
 * @param retentionDays How long a comment is kept.
 */
export function newsCommentPurgeCutoff(
  now: Date,
  retentionDays: number = NEWS_COMMENT_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  return new Date(
    now.getTime() - Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both functions need, for the reason purge-window.ts gives: a
 * window that is not a number would otherwise put the cutoff in the future and
 * erase comments whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `News comment retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

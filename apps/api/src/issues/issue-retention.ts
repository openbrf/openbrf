/**
 * How long an issue reported through the public form is kept, and when the
 * purge reaches it.
 *
 * Every other issue is keyed to a person, and the reporter link on it is
 * detached when that person's residency purge runs. An issue reported from the
 * public form is keyed to nobody: it carries the reporter's name and email as
 * ciphers and no personId at all, so no person-keyed purge will ever find it.
 * Without a clock of its own it would be the one place in the product where
 * contact details are kept for ever, which is exactly what a retention policy
 * exists to prevent.
 *
 * The clock is anchored on the day the issue was closed, not on the day it was
 * reported. The purpose the contact details are held for is being able to come
 * back to the person about the problem, and that purpose lasts as long as the
 * problem does: a leak reported in March and still being argued with a
 * contractor in December is a live matter, and erasing the reporter's email
 * halfway through would end the association's ability to answer them.
 *
 * `closedAt` and not `updatedAt`, which is the subtle one. Detaching some other
 * person from a neighbouring row is an update, and if the clock ran on
 * `updatedAt` every purge night would push these issues' own purge dates
 * further away. A clock that resets whenever the purge runs is not a clock.
 *
 * Two functions, one decision read from two ends, the shape and the reasoning
 * of `bookings/booking-retention.ts`: one date per row for what a report
 * states, one cutoff for what SQL can compare a whole table against. If they
 * disagree the product erases on a day other than the one it stated, so the
 * spec runs them against each other rather than trusting the arithmetic to look
 * symmetrical.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a closed public-form issue keeps its reporter's contact details.
 *
 * A year, matching the finished-booking window and chosen the same way: it
 * covers a heating season, so a problem that recurs the following winter can
 * still be tied to the person who first reported it, and it is short enough
 * that the association is not holding a stranger's email address indefinitely
 * because a tap once dripped.
 *
 * A constant rather than a board setting, for the reason booking retention
 * gives: the association's own policy answers a different question, about a
 * person whose relationship with the cooperative has ended. Somebody who filled
 * in a form on the website never had one.
 */
export const ISSUE_RETENTION_DAYS = 365;

/**
 * The date a closed issue's reporter details become erasable.
 *
 * @param closedAt When the issue was closed. Null while it is open, which has
 *   no purge date at all rather than one far in the future: the association is
 *   still working on the problem and still needs to be able to answer.
 * @param retentionDays How long a closed issue keeps them.
 */
export function computeIssuePurgeDate(
  closedAt: Date | null,
  retentionDays: number = ISSUE_RETENTION_DAYS,
): Date | null {
  assertRetentionDays(retentionDays);

  if (closedAt === null) {
    return null;
  }

  // Day arithmetic on the UTC instant rather than calendar fields, as every
  // other retention clock in the product does it: adding days in Europe/
  // Stockholm shifts the result by an hour across a daylight saving boundary,
  // and an erasure an hour before the stated date is still early.
  return new Date(
    closedAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest closing date whose purge date has arrived.
 *
 * An issue closed on or before this is erasable; one closed after it is not.
 *
 * @param now The moment the job is running at, passed in so a test can drive
 *   the clock rather than wait a year for it.
 * @param retentionDays How long a closed issue keeps its reporter details.
 */
export function issuePurgeCutoff(
  now: Date,
  retentionDays: number = ISSUE_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  return new Date(
    now.getTime() - Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both functions need, for the reason the booking and purge
 * windows give: a window that is not a number would otherwise put the cutoff in
 * the future and erase reporter details whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Issue retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

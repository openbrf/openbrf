import {
  compareLocalDays,
  localDayOf,
  localDayOfColumn,
  localDaysBetween,
} from "../bookings/stockholm-calendar";

/**
 * Where one duty to report a register event stands today.
 *
 * Its own pure module beside `report-deadline.ts`, which states the same
 * window's other end. Both are arithmetic on a calendar day with a way of being
 * wrong that a test written at midday cannot see, and neither needs a database.
 *
 * ## The four states, and why "overdue" is one of them
 *
 * Lag (2026:484) 3 kap. 10 § lets Lantmateriet order a late report in under
 * penalty of a fine, so a deadline that has passed is not a row further down a
 * list: it is the association exposed to a vite, and the only state on this
 * queue that costs money. It is therefore a state of its own rather than a
 * sorting of `due`, and the screen renders it as one.
 *
 * `outstanding` is a duty the statute sets no deadline for. There is exactly one
 * - the anmalan that a registered overlatelse has been havd or gone back to the
 * seller (3 kap. 3 § tredje stycket), which says the association "ska anmala"
 * where every other reporting sentence in the chapter says "inom tva veckor".
 * Its own state rather than `due` with an empty date, because the two are
 * different things to know: a due duty has a day it stops being safe to leave,
 * and this one does not. Folding it into `due` would put a blank in the column
 * a board scans for the next deadline; folding it into `overdue` would claim a
 * deadline had passed that was never set.
 *
 * `reported` is not derived from a date on the obligation. That table is
 * append-only on both of the statutory tier's mechanisms and a discharged duty
 * has no later state to reach there, so the fact that the anmalan was made lives
 * in the audit log - see the REGISTER_REPORT_MADE comment in schema.prisma. What
 * reaches this function is the day somebody stated it was made, or null.
 *
 * A reported duty stays reported whether or not it was reported in time. The
 * lateness is still readable, because the day stated and the day due are both on
 * the row, and overwriting the state with `overdue` would lose the only fact
 * that distinguishes a duty somebody dealt with late from one nobody has dealt
 * with at all.
 *
 * ## The day the count runs against
 *
 * `today` is the association's own calendar day, not an instant. A window closes
 * on a date, and an instant compared against a `@db.Date` column read back as
 * midnight UTC is a day out for part of the year - which for a two-week window
 * is a day of it, and the difference between a duty that is due and one that is
 * late.
 */

/** Where one duty stands. */
export type ReportState = "reported" | "overdue" | "due" | "outstanding";

/**
 * The state of one duty.
 *
 * @param dueOn The statutory deadline, as a date column value, or null where the
 *   section that imposes the duty sets no period.
 * @param reportedOn The day the anmalan was stated to have reached Lantmateriet,
 *   as a date column value, or null where nobody has stated one.
 * @param now Any instant; the association's calendar day is taken from it.
 */
export function reportState(input: {
  dueOn: Date | null;
  reportedOn: Date | null;
  now: Date;
}): ReportState {
  if (input.reportedOn !== null) {
    return "reported";
  }
  if (input.dueOn === null) {
    return "outstanding";
  }
  return (daysUntilDue(input.dueOn, input.now) ?? 0) < 0 ? "overdue" : "due";
}

/**
 * Calendar days from today to the deadline: zero on the last day, negative once
 * it has passed, and null where the statute sets no deadline.
 *
 * Zero is inside the window and not outside it. "Inom tva veckor" includes the
 * fourteenth day, so a duty due today is due and not late, and the boundary is
 * the one case this function exists to get right.
 *
 * Null rather than a large number or a zero for an undated duty. Both would read
 * on a screen as a count of days, and a count of days towards a deadline that
 * does not exist is the one answer this must not give.
 */
export function daysUntilDue(dueOn: Date | null, now: Date): number | null {
  return dueOn === null
    ? null
    : localDaysBetween(localDayOf(now), localDayOfColumn(dueOn));
}

/**
 * Comparison putting the queue in the order a board works it.
 *
 * Deadline first and the earliest first, so the duty closest to a fine is at the
 * top and an overdue one is above every duty still inside its window. The
 * obligation id breaks a tie, so two duties falling due on one day come back in
 * the same order every time a screen is loaded - two rows that swap places
 * between two reads read as a list that changed when nothing did.
 *
 * A duty the statute sets no deadline for sorts after every dated one, whatever
 * date that one carries. Nothing about it is closer to a fine than a dated duty
 * is: 3 kap. 10 § lets Lantmateriet order in a late anmalan "for registrering av
 * upplatelse eller overgang" or of a bostadsratt having ceased, and a reversal
 * under 3 kap. 3 § tredje stycket is none of those. Two undated duties order by
 * id alone, which is stable across reads, and the queue groups them separately
 * anyway - this is what keeps them out of the middle of the dated ones when
 * something reads the list flat.
 */
export function compareByDeadline(
  first: { dueOn: Date | null; id: string },
  second: { dueOn: Date | null; id: string },
): number {
  if (first.dueOn === null || second.dueOn === null) {
    if (first.dueOn !== null) {
      return -1;
    }
    if (second.dueOn !== null) {
      return 1;
    }
    return first.id.localeCompare(second.id);
  }
  const byDay = compareLocalDays(
    localDayOfColumn(first.dueOn),
    localDayOfColumn(second.dueOn),
  );
  return byDay === 0 ? first.id.localeCompare(second.id) : byDay;
}

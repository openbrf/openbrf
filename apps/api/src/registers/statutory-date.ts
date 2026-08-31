import {
  compareLocalDays,
  dateColumnOf,
  type LocalDay,
  localDayOf,
  parseLocalDay,
} from "../bookings/stockholm-calendar";

/**
 * A calendar date a board states about a statutory event, checked and converted.
 *
 * Its own module, and pure, because both halves of it have gone wrong in this
 * codebase before and neither is testable through a service that needs a
 * database. The dates it guards are the day a tenant-ownership ceased and the
 * day the association decided on a membership - both of them the start of a
 * statutory two-week window under Lag (2026:484) 3 kap., and both on rows the
 * database will not let anyone correct afterwards.
 *
 * ## The conversion
 *
 * The column is `@db.Date`, which carries no time and no zone. It is written
 * through {@link dateColumnOf} rather than through `new Date(text)`: those
 * agree today, and the point is that nothing here depends on their agreeing,
 * because the same file also compares the value.
 *
 * ## The comparison
 *
 * This is the recurring bug in this repository, found twice at opposite ends of
 * one predicate in the booking module. A date column read back is midnight UTC;
 * an instant from `new Date()` is a moment. Comparing them as instants asks a
 * question about hours, and the question here is about days.
 *
 * Concretely: Stockholm runs one or two hours ahead of UTC, so between local
 * midnight and 01:00 or 02:00 the UTC date is still yesterday's. A board
 * recording, at half past midnight, a cessation that happened that day would be
 * told the day is in the future - and a board recording one at half past
 * midnight on the day after would be allowed to date it tomorrow. Both are
 * wrong, and both are invisible to a test written at midday.
 *
 * {@link localDayOf} reads the Stockholm calendar date off the instant and
 * {@link compareLocalDays} compares two calendar dates as calendar dates, which
 * is the only comparison that is right in July and in the last week of October
 * alike. Nothing in this file derives an offset.
 */

/** Why a stated date was refused. */
export type StatutoryDateProblem =
  "date-not-a-calendar-date" | "date-in-the-future";

export type StatutoryDate =
  | {
      ok: true;
      /** The date on the association's wall calendar. */
      day: LocalDay;
      /** The value to write into the `@db.Date` column. */
      column: Date;
    }
  | { ok: false; problem: StatutoryDateProblem };

/**
 * A "YYYY-MM-DD" date that has already arrived, as a date column value.
 *
 * Strict about the date being real: a regular expression accepts "2027-02-30"
 * and `Date.parse` answers the 2nd of March, so a board mis-typing a month
 * would silently get a different day on a row nobody can correct.
 *
 * Refuses a date in the future rather than storing it. A tenant-ownership that
 * has not ceased cannot be reported as having ceased, and a membership decision
 * the board has not taken has no date to record.
 *
 * @param now The instant to read "today" off, injected so the boundary between
 *   local midnight and the UTC date change is testable rather than a thing that
 *   is only wrong for two hours a night.
 */
export function statutoryDate(text: string, now: Date): StatutoryDate {
  const day = parseLocalDay(text);
  if (day === null) {
    return { ok: false, problem: "date-not-a-calendar-date" };
  }
  if (compareLocalDays(day, localDayOf(now)) > 0) {
    return { ok: false, problem: "date-in-the-future" };
  }
  return { ok: true, day, column: dateColumnOf(day) };
}

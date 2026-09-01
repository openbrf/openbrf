import {
  addLocalDays,
  dateColumnOf,
  localDayOfColumn,
} from "../bookings/stockholm-calendar";

/**
 * When a report to the cooperative housing register falls due.
 *
 * Its own module and pure, beside `statutory-date.ts`, which guards the dates
 * this one counts from. Both halves of the arithmetic have a way of being wrong
 * that a test written at midday cannot see, and neither needs a database to
 * check.
 *
 * ## The fourteen days
 *
 * Lag (2026:484) 3 kap. states the same window in each of its three reporting
 * sections - "inom tva veckor" from the day it names - and neither lengthens nor
 * shortens it for a weekend or a holiday. So the deadline is fourteen calendar
 * days after the day the window opened, and nothing here consults a calendar of
 * working days.
 *
 * Which day that is differs by section, and choosing it is the caller's:
 * 3 kap. 3 § andra stycket runs an overgang from the day the association decided
 * on membership, and 3 kap. 4 § runs a termination from the day the bostadsratt
 * ceased. This function is handed the day and states the deadline.
 *
 * ## The arithmetic
 *
 * Calendar arithmetic on a date column value, not instant arithmetic on a
 * moment. Both the day counted from and the day counted to live in `@db.Date`
 * columns, which carry no time and no zone and are read back as midnight UTC, so
 * the value goes out through {@link localDayOfColumn}, is shifted as a calendar
 * date, and comes back through {@link dateColumnOf}. Adding fourteen times
 * 86 400 000 milliseconds to the instant would agree with this today and would
 * stop agreeing the moment anything handed this function a locally anchored
 * instant instead - which is the same distinction `holding-periods.ts` closes
 * with about the dates it compares.
 */

/**
 * The statutory window, in days.
 *
 * Exported because the database states the same rule as a CHECK
 * (`register_report_obligation_two_week_window` in 20260910100000), and a test
 * that asserted "14" as a literal in both places would pass with the two
 * disagreeing.
 */
export const REPORT_WINDOW_DAYS = 14;

/**
 * The day a report is due, as a `@db.Date` column value.
 *
 * @param triggeredOn The day the statutory window opened, as read from or
 *   written to a date column.
 */
export function reportDueOn(triggeredOn: Date): Date {
  return dateColumnOf(
    addLocalDays(localDayOfColumn(triggeredOn), REPORT_WINDOW_DAYS),
  );
}

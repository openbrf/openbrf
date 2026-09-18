import { dateColumnOf, localDayOf, localDayOfColumn } from "@openbrf/shared";

/**
 * The association's financial year, and the preservation window that hangs off
 * it.
 *
 * Bokforingslagen (1999:1078) 7 kap. 2 § preserves the documents that carry
 * rakenskapsinformation "fram till och med det sjunde aret efter utgangen av
 * det kalenderar da rakenskapsaret avslutades". Every word of that is about the
 * financial year: the clock starts at the end of the calendar year in which the
 * financial year closed, not at the end of the calendar year the row falls in.
 * For an association running the calendar year the two are the same sentence,
 * which is why the distinction stayed invisible until the platform recorded a
 * financial year at all.
 *
 * ## What a broken financial year moves, and in which direction
 *
 * 3 kap. 1 § makes a rakenskapsar twelve calendar months, so the month it
 * starts in states the whole of it. Take an association whose year runs from
 * the 1st of May. A row dated the 15th of June 2026 falls in the year that ends
 * on the 30th of April 2027, so its preservation runs from the end of 2027 and
 * it is kept through 2034. A row dated the 15th of March 2026 falls in the year
 * that ended on the 30th of April 2026, so its preservation runs from the end
 * of 2026 and it is kept through 2033. Two rows eleven weeks apart, a year
 * apart in when they may be erased.
 *
 * Anchoring on the row's own calendar year instead gets the second right and
 * the first a full year early - and never late, for any start month. The end
 * year of the financial year containing a day is never earlier than that day's
 * own calendar year, so reading the row's year can only understate how long the
 * row is preserved. That is the direction that matters: correcting it moves
 * erasure dates later and never earlier, so no date a data subject access
 * report has already stated to a named person is brought forward by it.
 *
 * 3 kap. 3 § allows a shorter or longer year when the obligation begins or the
 * year is changed over. That is one period in an association's history rather
 * than its standing year, and the platform records the standing one; a row
 * inside such a period is preserved on the standing year's reading, which errs
 * towards keeping.
 *
 * ## Two functions, read from opposite ends
 *
 * {@link preservationEndOf} answers "when is this row erasable", which is a
 * computation per row and what a data subject access report states.
 * {@link preservationCutoff} asks the opposite question of a whole table at
 * once - "which rows fall in a financial year that has fallen out" - which has
 * to be one comparison in SQL. They are in one file because they are one
 * decision read from two ends, and `financial-year.spec.ts` runs them against
 * each other rather than trusting the arithmetic to look symmetrical.
 */

/** January, the start month of a financial year that is the calendar year. */
export const CALENDAR_YEAR_START_MONTH = 1;

/**
 * The calendar year in which the financial year containing a day ended.
 *
 * @param day The day, as a `@db.Date` column holds it. Read as a calendar date
 *   rather than as an instant, because a date column carries neither a time nor
 *   a zone - and reading the local fields off midnight UTC puts a New Year's Eve
 *   row in the previous year in Stockholm.
 * @param startMonth The month the association's financial year begins in.
 */
export function financialYearEndYearOfColumn(
  day: Date,
  startMonth: number,
): number {
  assertStartMonth(startMonth);

  const { year, month } = localDayOfColumn(day);
  // A year starting in January ends in its own calendar year. Any other starts
  // in one calendar year and ends in the next, so a day on or after the start
  // month belongs to the year that will end next year, and a day before it to
  // the year that ended this one.
  return startMonth === CALENDAR_YEAR_START_MONTH || month < startMonth
    ? year
    : year + 1;
}

/**
 * The first day of the financial year that ends in a stated calendar year.
 *
 * @param endYear The calendar year the financial year ends in.
 * @param startMonth The month the association's financial year begins in.
 */
export function financialYearStartColumn(
  endYear: number,
  startMonth: number,
): Date {
  assertStartMonth(startMonth);

  return dateColumnOf({
    year: startMonth === CALENDAR_YEAR_START_MONTH ? endYear : endYear - 1,
    month: startMonth,
    day: 1,
  });
}

/**
 * The date a row dated on a day becomes erasable: the first morning after the
 * preservation period in 7 kap. 2 § has run out.
 *
 * @param day The day the row is dated, as the `@db.Date` column holds it.
 * @param startMonth The month the association's financial year begins in.
 * @param retentionYears How many full calendar years after the one the
 *   financial year ended in the row is kept.
 */
export function preservationEndOf(
  day: Date,
  startMonth: number,
  retentionYears: number,
): Date {
  assertRetentionYears(retentionYears);

  return dateColumnOf({
    year: financialYearEndYearOfColumn(day, startMonth) + retentionYears + 1,
    month: 1,
    day: 1,
  });
}

/**
 * The first date that is still preserved.
 *
 * A row dated before this is erasable; one dated on or after it is not. A bound
 * rather than a last-erasable date because the comparison it feeds is over a
 * date column, and `lt` against one day says what "the financial year has
 * fallen out" means without any arithmetic about the last day of it.
 *
 * Because the end year of the financial year containing a day only ever rises
 * as the day does, the erasable rows are exactly those dated before the start
 * of one financial year - which is what makes a single comparison correct here
 * rather than an approximation of a per-row rule.
 *
 * @param now The moment the job is running at, passed in so a test can drive
 *   the clock rather than wait seven years for it. Which year that is is read on
 *   the association's own calendar: a run starting at half past midnight on New
 *   Year's Day is running in the new year in Stockholm and in the old one in
 *   UTC, and the whole window is stated in calendar years.
 * @param startMonth The month the association's financial year begins in.
 * @param retentionYears How many full calendar years after the one the
 *   financial year ended in the row is kept.
 */
export function preservationCutoff(
  now: Date,
  startMonth: number,
  retentionYears: number,
): Date {
  assertRetentionYears(retentionYears);

  // The oldest financial year still preserved is the one that ended this many
  // calendar years ago; everything dated before it began has fallen out.
  return financialYearStartColumn(
    localDayOf(now).year - retentionYears,
    startMonth,
  );
}

/**
 * Refuses a start month that is not a month of the year.
 *
 * Refused rather than wrapped or clamped. A wrapped month would silently move
 * the financial year, and with it the day every row in the table is erased on,
 * which is a promise the platform has already stated per row.
 */
export function assertStartMonth(startMonth: number): void {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError(
      `A financial year starts in a month of the year, got ${String(startMonth)}.`,
    );
  }
}

/**
 * Refuses a retention window that is not a number of whole years.
 *
 * The same refusal both functions need, for the reason `purge-window.ts` gives:
 * a window that is not a number would otherwise put the cutoff in the future and
 * erase rows whose retention had not run out - including ones from the financial
 * year that is still running.
 *
 * Whole years and not a fraction, because the window is stated in calendar years
 * and there is no half of one to anchor on. Rounding a fraction here would erase
 * on a year other than the one the caller asked for, without saying so; the
 * value is refused instead.
 */
function assertRetentionYears(retentionYears: number): void {
  if (!Number.isInteger(retentionYears) || retentionYears < 0) {
    throw new RangeError(
      `Preservation must be a non-negative whole number of years, got ${String(
        retentionYears,
      )}.`,
    );
  }
}

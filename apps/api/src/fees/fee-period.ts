import {
  compareLocalDays,
  formatLocalDay,
  type LocalDay,
} from "@openbrf/shared";

/**
 * What a billable period is, and what one apartment owes for it.
 *
 * ## Whole calendar months, because the arithmetic has to be exact
 *
 * A rate says what an apartment pays for one calendar month. What it owes for a
 * period is that figure multiplied by the months in the period, which is exact
 * in ore. A period that ended halfway through a month would need a division,
 * and a division of kronor by days produces a figure that is not a sum of
 * kronor and ore - so the period is bounded to whole months and one that is not
 * is refused rather than apportioned. This product refuses a malformed amount
 * everywhere else for the same reason, and a notice is the document a member
 * pays from.
 *
 * ## The rate in force is the rate at the start of the month
 *
 * A month is billed at the rate that applied on its first day. A rate that
 * begins mid-month therefore first bills the month after, and one that ends
 * mid-month bills that month in full. Stated rather than derived: the
 * alternative is a part month, which is the division the paragraph above
 * refuses, and a board changing a rate does so with a month boundary in mind
 * because that is how the money arrives.
 *
 * ## Summed in ore
 *
 * `BigInt` over integer ore, not addition of numbers with a decimal point. A
 * few hundred amounts added up in binary floating point produce a total ending
 * in a cent that is not there, and these are the figures a member pays and a
 * bookkeeper reconciles. An amount that is not what a `DECIMAL(14, 2)` renders
 * is refused rather than rounded.
 */

/** The first day of each calendar month in a period, in order. */
export function monthsIn(from: LocalDay, to: LocalDay): LocalDay[] {
  const months: LocalDay[] = [];
  let year = from.year;
  let month = from.month;

  while (
    compareLocalDays({ year, month, day: 1 }, to) <= 0 &&
    months.length <= MAX_MONTHS_PER_PERIOD
  ) {
    months.push({ year, month, day: 1 });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

/**
 * The most months one notification run may bill.
 *
 * Eighteen, which is the longest a rakenskapsar may be made under
 * bokforingslagen (1999:1078) 3 kap. 3 § when the year is changed over. A bound
 * rather than none, because the period comes from a form and a run over a
 * century of months would build a query per month before anything refused it.
 */
export const MAX_MONTHS_PER_PERIOD = 18;

/** Whether a period is a whole number of calendar months, end to end. */
export function isWholeMonths(from: LocalDay, to: LocalDay): boolean {
  if (compareLocalDays(from, to) > 0) {
    return false;
  }
  if (from.day !== 1) {
    return false;
  }
  return to.day === lastDayOfMonth(to.year, to.month);
}

/**
 * The last day of a calendar month.
 *
 * Day zero of the following month, which is how the Date constructor spells the
 * last day of this one, and which gets February right in a leap year without
 * this module knowing the rule. Built in UTC because it is asked about a
 * calendar month and not about an instant.
 */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The period as the two "YYYY-MM-DD" strings a payload carries. */
export function formatPeriod(
  from: LocalDay,
  to: LocalDay,
): { from: string; to: string } {
  return { from: formatLocalDay(from), to: formatLocalDay(to) };
}

/**
 * The sum of a set of amounts, as a decimal string with two places.
 *
 * The amounts arrive as the decimal column's own rendering, which is always
 * `<digits>.<two digits>` for a `DECIMAL(14, 2)`; anything else is a value the
 * table cannot hold and is refused rather than rounded, because a total that
 * silently dropped a row would be worse than no total.
 */
export function sumAmounts(amounts: readonly string[]): string {
  let ore = 0n;
  for (const amount of amounts) {
    ore += oreOf(amount);
  }
  return formatOre(ore);
}

/**
 * One month's amount multiplied by a number of months, as a decimal string.
 *
 * Exact, because both operands are integers: ore times a count of months is
 * ore. This is the whole reason the rate is stated per month rather than per
 * year.
 */
export function amountForMonths(monthlyAmount: string, months: number): string {
  if (!Number.isInteger(months) || months < 0) {
    throw new RangeError(
      `A period is a whole number of months, got ${String(months)}.`,
    );
  }
  return formatOre(oreOf(monthlyAmount) * BigInt(months));
}

/** A decimal amount as whole ore. */
function oreOf(amount: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(amount);
  const kronor = match?.[1];
  const ore = match?.[2];
  if (kronor === undefined || ore === undefined) {
    throw new RangeError(`A fee amount is not a decimal sum: ${amount}`);
  }
  return BigInt(kronor) * 100n + BigInt(ore);
}

/** Whole ore as the decimal string a `DECIMAL(14, 2)` renders. */
function formatOre(ore: bigint): string {
  return `${String(ore / 100n)}.${String(ore % 100n).padStart(2, "0")}`;
}

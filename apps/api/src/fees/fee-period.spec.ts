import { parseLocalDay } from "@openbrf/shared";
import { describe, expect, it } from "vitest";

import {
  amountForMonths,
  isWholeMonths,
  lastDayOfMonth,
  MAX_MONTHS_PER_PERIOD,
  monthsIn,
  sumAmounts,
} from "./fee-period";

/** A local day for a "YYYY-MM-DD", which the parser answers for a valid one. */
function day(text: string) {
  const parsed = parseLocalDay(text);
  if (parsed === null) {
    throw new Error(`not a date: ${text}`);
  }
  return parsed;
}

describe("monthsIn", () => {
  it("lists the first day of each month in the period", () => {
    expect(
      monthsIn(day("2026-01-01"), day("2026-03-31")).map((m) => m.month),
    ).toEqual([1, 2, 3]);
  });

  it("crosses a year boundary", () => {
    expect(monthsIn(day("2026-11-01"), day("2027-02-28"))).toEqual([
      { year: 2026, month: 11, day: 1 },
      { year: 2026, month: 12, day: 1 },
      { year: 2027, month: 1, day: 1 },
      { year: 2027, month: 2, day: 1 },
    ]);
  });

  it("is one month for a single month", () => {
    expect(monthsIn(day("2026-02-01"), day("2026-02-28"))).toHaveLength(1);
  });

  it("stops at the bound rather than running on", () => {
    // The period comes from a form, so the bound is what keeps a typing mistake
    // from building a query per month for a century before anything refuses it.
    expect(
      monthsIn(day("2026-01-01"), day("2126-01-31")).length,
    ).toBeLessThanOrEqual(MAX_MONTHS_PER_PERIOD + 1);
  });
});

describe("isWholeMonths", () => {
  it("accepts a period that opens on a 1st and closes on a month end", () => {
    expect(isWholeMonths(day("2026-01-01"), day("2026-03-31"))).toBe(true);
    expect(isWholeMonths(day("2026-02-01"), day("2026-02-28"))).toBe(true);
    // A leap February, which the day-zero rule gets right without a rule of its
    // own here.
    expect(isWholeMonths(day("2028-02-01"), day("2028-02-29"))).toBe(true);
  });

  it("refuses a part month at either end", () => {
    expect(isWholeMonths(day("2026-01-15"), day("2026-03-31"))).toBe(false);
    expect(isWholeMonths(day("2026-01-01"), day("2026-03-30"))).toBe(false);
    expect(isWholeMonths(day("2028-02-01"), day("2028-02-28"))).toBe(false);
  });

  it("refuses a period that runs backwards", () => {
    expect(isWholeMonths(day("2026-03-01"), day("2026-01-31"))).toBe(false);
  });
});

describe("lastDayOfMonth", () => {
  it("knows February in both kinds of year", () => {
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(lastDayOfMonth(2100, 2)).toBe(28);
  });

  it("knows the thirty-day months", () => {
    expect(lastDayOfMonth(2026, 4)).toBe(30);
    expect(lastDayOfMonth(2026, 12)).toBe(31);
  });
});

describe("amountForMonths", () => {
  it("multiplies in ore", () => {
    expect(amountForMonths("3450.50", 3)).toBe("10351.50");
    expect(amountForMonths("0.01", 12)).toBe("0.12");
  });

  it("is exact where a yearly figure divided by twelve is not", () => {
    // The reason the rate is stated per month. A yearly 10000.00 apportioned to
    // a month has no exact answer, and this product refuses a malformed amount
    // rather than rounding one; a monthly 833.33 has an exact answer for any
    // number of months.
    expect(amountForMonths("833.33", 12)).toBe("9999.96");
  });

  it("refuses a count that is not a whole number of months", () => {
    expect(() => amountForMonths("450.00", 1.5)).toThrow(RangeError);
    expect(() => amountForMonths("450.00", -1)).toThrow(RangeError);
  });

  it("refuses an amount the column cannot hold", () => {
    expect(() => amountForMonths("450", 1)).toThrow(RangeError);
    expect(() => amountForMonths("450,00", 1)).toThrow(RangeError);
  });
});

describe("sumAmounts", () => {
  it("adds in ore rather than in binary floating point", () => {
    // 0.1 + 0.2 in a double is not 0.3, and this is the figure a bookkeeper
    // reconciles their own against.
    expect(sumAmounts(["0.10", "0.20"])).toBe("0.30");
    expect(sumAmounts(["3450.50", "1200.25", "899.25"])).toBe("5550.00");
  });

  it("is zero over nothing", () => {
    expect(sumAmounts([])).toBe("0.00");
  });

  it("refuses rather than rounds", () => {
    expect(() => sumAmounts(["450.00", "12.345"])).toThrow(RangeError);
  });
});

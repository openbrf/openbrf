import { dateColumnOf } from "@openbrf/shared";
import { describe, expect, it } from "vitest";

import {
  CALENDAR_YEAR_START_MONTH,
  financialYearEndYearOfColumn,
  financialYearStartColumn,
  preservationCutoff,
  preservationEndOf,
} from "./financial-year";

/**
 * The preservation window, read from both ends and against a broken financial
 * year.
 *
 * Two promises are asserted here. The two functions agree, because a
 * disagreement means erasing on a day other than the one the data subject
 * access report stated. And the calendar year is the special case rather than
 * the rule: on a start month of January every answer is the one the window gave
 * before it read a financial year at all, which is what makes the correction
 * safe for every instance already running.
 */

/** A date column value for a "YYYY-MM-DD". */
function day(text: string): Date {
  const [year, month, date] = text.split("-").map(Number);
  return dateColumnOf({
    year: year ?? 0,
    month: month ?? 0,
    day: date ?? 0,
  });
}

/** An instant at midday in Stockholm on a stated day, well away from midnight. */
function middayOn(text: string): Date {
  return new Date(`${text}T12:00:00.000+02:00`);
}

/** A financial year running from the 1st of May to the 30th of April. */
const MAY = 5;

describe("financialYearEndYearOfColumn", () => {
  it("is the row's own year when the financial year is the calendar year", () => {
    expect(
      financialYearEndYearOfColumn(
        day("2026-01-01"),
        CALENDAR_YEAR_START_MONTH,
      ),
    ).toBe(2026);
    expect(
      financialYearEndYearOfColumn(
        day("2026-12-31"),
        CALENDAR_YEAR_START_MONTH,
      ),
    ).toBe(2026);
  });

  it("is next year for a day on or after a broken year's start month", () => {
    // 1 May 2026 to 30 April 2027, so a June row is preserved from the end of
    // 2027 and not from the end of 2026.
    expect(financialYearEndYearOfColumn(day("2026-05-01"), MAY)).toBe(2027);
    expect(financialYearEndYearOfColumn(day("2026-06-15"), MAY)).toBe(2027);
    expect(financialYearEndYearOfColumn(day("2026-12-31"), MAY)).toBe(2027);
  });

  it("is this year for a day before it", () => {
    // 1 May 2025 to 30 April 2026: the year that ended this calendar year.
    expect(financialYearEndYearOfColumn(day("2026-01-01"), MAY)).toBe(2026);
    expect(financialYearEndYearOfColumn(day("2026-04-30"), MAY)).toBe(2026);
  });

  it("reads the day as a calendar date and not as an instant", () => {
    /*
     * The recurring bug in this repository. A date column is read back as
     * midnight UTC, which is the evening before in Stockholm for part of the
     * year - so reading the local fields off that instant would put a New
     * Year's Eve row in the previous year's financial year and erase it a year
     * early.
     */
    expect(
      financialYearEndYearOfColumn(
        day("2026-12-31"),
        CALENDAR_YEAR_START_MONTH,
      ),
    ).toBe(2026);
    expect(
      financialYearEndYearOfColumn(
        day("2027-01-01"),
        CALENDAR_YEAR_START_MONTH,
      ),
    ).toBe(2027);
  });

  it("refuses a start month no year has", () => {
    expect(() => financialYearEndYearOfColumn(day("2026-06-15"), 0)).toThrow(
      RangeError,
    );
    expect(() => financialYearEndYearOfColumn(day("2026-06-15"), 13)).toThrow(
      RangeError,
    );
    expect(() => financialYearEndYearOfColumn(day("2026-06-15"), 5.5)).toThrow(
      RangeError,
    );
  });
});

describe("financialYearStartColumn", () => {
  it("is the 1st of January of the year it ends in, on the calendar year", () => {
    expect(
      financialYearStartColumn(2026, CALENDAR_YEAR_START_MONTH).toISOString(),
    ).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is the start month of the previous year on a broken one", () => {
    expect(financialYearStartColumn(2027, MAY).toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
  });
});

describe("preservationEndOf", () => {
  it("erases at the start of the eighth year after the one the year ended in", () => {
    // Bokforingslagen 7 kap. 2 § preserves through the seventh year after the
    // calendar year the financial year closed, so a 2026 row on the calendar
    // year is kept through 2033 and erasable on the first morning of 2034.
    expect(
      preservationEndOf(
        day("2026-03-05"),
        CALENDAR_YEAR_START_MONTH,
        7,
      ).toISOString(),
    ).toBe("2034-01-01T00:00:00.000Z");
  });

  it("keeps a broken year's first half a year longer than its own calendar year", () => {
    // The whole of the correction, in one pair. June 2026 falls in the year
    // ending April 2027 and is kept through 2034; March 2026 falls in the year
    // that ended April 2026 and is kept through 2033.
    expect(preservationEndOf(day("2026-06-15"), MAY, 7).toISOString()).toBe(
      "2035-01-01T00:00:00.000Z",
    );
    expect(preservationEndOf(day("2026-03-15"), MAY, 7).toISOString()).toBe(
      "2034-01-01T00:00:00.000Z",
    );
  });

  it("never erases earlier than the row's own calendar year would", () => {
    /*
     * The property that makes correcting a shipped window safe. The end year of
     * the financial year containing a day is never before that day's own
     * calendar year, so every erasure date this produces is on or after the one
     * the uncorrected rule produced - and no date already stated to a named
     * person is brought forward.
     */
    for (let startMonth = 1; startMonth <= 12; startMonth++) {
      for (const text of [
        "2026-01-01",
        "2026-04-30",
        "2026-05-01",
        "2026-08-17",
        "2026-12-31",
      ]) {
        const uncorrected = preservationEndOf(
          day(text),
          CALENDAR_YEAR_START_MONTH,
          7,
        );
        expect(
          preservationEndOf(day(text), startMonth, 7).getTime(),
        ).toBeGreaterThanOrEqual(uncorrected.getTime());
      }
    }
  });

  it("refuses a window that is not a number of years", () => {
    expect(() =>
      preservationEndOf(
        day("2026-03-05"),
        CALENDAR_YEAR_START_MONTH,
        Number.NaN,
      ),
    ).toThrow(RangeError);
    expect(() =>
      preservationEndOf(day("2026-03-05"), CALENDAR_YEAR_START_MONTH, -1),
    ).toThrow(RangeError);
    // Refused rather than rounded: half a calendar year is not a thing to
    // anchor on, and rounding it would erase a year off what was asked for
    // without saying so.
    expect(() =>
      preservationEndOf(day("2026-03-05"), CALENDAR_YEAR_START_MONTH, 6.5),
    ).toThrow(RangeError);
  });
});

describe("preservationCutoff", () => {
  it("takes the year from the association's own calendar", () => {
    /*
     * Half past midnight on New Year's Day in Stockholm is still the 31st of
     * December in UTC. A run at that moment is running in the new year, so the
     * cohort that has just fallen out is the one this asserts - reading the year
     * off the UTC instant would leave it in place for another day.
     */
    expect(
      preservationCutoff(
        new Date("2034-01-01T00:30:00.000+01:00"),
        CALENDAR_YEAR_START_MONTH,
        7,
      ).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
  });

  it("cuts at the start of a financial year on a broken one", () => {
    expect(
      preservationCutoff(middayOn("2034-06-01"), MAY, 7).toISOString(),
    ).toBe("2026-05-01T00:00:00.000Z");
  });

  it("refuses a window that is not a number of years", () => {
    expect(() =>
      preservationCutoff(
        middayOn("2034-06-01"),
        CALENDAR_YEAR_START_MONTH,
        Number.NaN,
      ),
    ).toThrow(RangeError);
    expect(() =>
      preservationCutoff(
        middayOn("2034-06-01"),
        CALENDAR_YEAR_START_MONTH,
        6.5,
      ),
    ).toThrow(RangeError);
  });
});

describe("the two agree", () => {
  const days = [
    "2026-01-01",
    "2026-03-05",
    "2026-04-30",
    "2026-05-01",
    "2026-12-31",
    "2027-07-15",
    "2028-02-29",
  ];

  it.each([1, 2, 5, 7, 9, 12])(
    "a row is erasable exactly from its stated date, on a year starting in month %i",
    (startMonth) => {
      for (const text of days) {
        const dated = day(text);
        const erasableFrom = preservationEndOf(dated, startMonth, 7);
        const stated = erasableFrom.toISOString().slice(0, 10);

        // On the stated day the scan reaches it.
        expect(dated.getTime()).toBeLessThan(
          preservationCutoff(middayOn(stated), startMonth, 7).getTime(),
        );

        // The day before, it does not.
        const before = new Date(erasableFrom.getTime() - 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        expect(dated.getTime()).toBeGreaterThanOrEqual(
          preservationCutoff(middayOn(before), startMonth, 7).getTime(),
        );
      }
    },
  );

  it("keeps that agreement when the window is shortened", () => {
    /*
     * The window is a constant the product may shorten without a migration,
     * because every date is derived. A shortening that moved one function and
     * not the other would erase on a day no report had ever stated, so both are
     * driven with the same non-default value.
     */
    const dated = day("2026-06-01");
    expect(preservationEndOf(dated, MAY, 2).toISOString()).toBe(
      "2030-01-01T00:00:00.000Z",
    );
    expect(dated.getTime()).toBeLessThan(
      preservationCutoff(middayOn("2030-01-01"), MAY, 2).getTime(),
    );
    expect(dated.getTime()).toBeGreaterThanOrEqual(
      preservationCutoff(middayOn("2029-12-31"), MAY, 2).getTime(),
    );
  });
});

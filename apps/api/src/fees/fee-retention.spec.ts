import { dateColumnOf } from "@openbrf/shared";
import { describe, expect, it } from "vitest";

import { CALENDAR_YEAR_START_MONTH } from "../retention/financial-year";
import {
  computeFeePurgeDate,
  FEE_RETENTION_YEARS,
  feePurgeCutoff,
} from "./fee-retention";

/**
 * The fee retention window, read from both ends.
 *
 * The two functions answer opposite questions about one rule and the product's
 * promise is that they agree: a disagreement means erasing on a day other than
 * the one the data subject access report stated. The arithmetic itself,
 * including every case a broken financial year creates, is asserted in
 * `retention/financial-year.spec.ts`; what is asserted here is this module's own
 * promises.
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

describe("computeFeePurgeDate", () => {
  it("erases at the start of the eighth year after the financial year's own", () => {
    // Bokforingslagen 7 kap. 2 § preserves through the seventh year after the
    // calendar year the financial year closed, so a period ending in 2026 on the
    // calendar year is erasable on the first morning of 2034.
    expect(computeFeePurgeDate(day("2026-03-31")).toISOString()).toBe(
      "2034-01-01T00:00:00.000Z",
    );
  });

  it("follows the association's financial year rather than the row's own", () => {
    // On a year running from the 1st of May, a period ending in June 2026 falls
    // in the year that ends the following April.
    expect(computeFeePurgeDate(day("2026-06-30"), MAY).toISOString()).toBe(
      "2035-01-01T00:00:00.000Z",
    );
    expect(computeFeePurgeDate(day("2026-03-31"), MAY).toISOString()).toBe(
      "2034-01-01T00:00:00.000Z",
    );
  });

  it("gives every row in one financial year the same date", () => {
    expect(computeFeePurgeDate(day("2026-01-31"))).toEqual(
      computeFeePurgeDate(day("2026-12-31")),
    );
  });

  it("reads the date as a calendar date and not as an instant", () => {
    // A date column is read back as midnight UTC, which is the evening before in
    // Stockholm for part of the year.
    expect(computeFeePurgeDate(day("2026-12-31")).toISOString()).toBe(
      "2034-01-01T00:00:00.000Z",
    );
    expect(computeFeePurgeDate(day("2027-01-01")).toISOString()).toBe(
      "2035-01-01T00:00:00.000Z",
    );
  });

  it("refuses a window that is not a number of years", () => {
    expect(() =>
      computeFeePurgeDate(day("2026-03-31"), CALENDAR_YEAR_START_MONTH, -1),
    ).toThrow(RangeError);
    expect(() =>
      computeFeePurgeDate(day("2026-03-31"), CALENDAR_YEAR_START_MONTH, 6.5),
    ).toThrow(RangeError);
  });
});

describe("the two agree", () => {
  it.each([
    ["2026-01-31", CALENDAR_YEAR_START_MONTH],
    ["2026-12-31", CALENDAR_YEAR_START_MONTH],
    ["2026-04-30", MAY],
    ["2026-05-01", MAY],
    ["2027-06-30", MAY],
  ])(
    "a row dated %s is erasable exactly from its stated date",
    (text, startMonth) => {
      const dated = day(text);
      const purgeOn = computeFeePurgeDate(dated, startMonth);
      const stated = purgeOn.toISOString().slice(0, 10);

      // On the stated day the scan reaches it.
      expect(dated.getTime()).toBeLessThan(
        feePurgeCutoff(middayOn(stated), startMonth).getTime(),
      );

      // The day before, it does not.
      const before = new Date(purgeOn.getTime() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      expect(dated.getTime()).toBeGreaterThanOrEqual(
        feePurgeCutoff(middayOn(before), startMonth).getTime(),
      );
    },
  );

  it("keeps that agreement when the window is shortened", () => {
    const dated = day("2026-06-30");
    const purgeOn = computeFeePurgeDate(dated, CALENDAR_YEAR_START_MONTH, 2);
    expect(purgeOn.toISOString()).toBe("2029-01-01T00:00:00.000Z");
    expect(dated.getTime()).toBeLessThan(
      feePurgeCutoff(
        middayOn("2029-01-01"),
        CALENDAR_YEAR_START_MONTH,
        2,
      ).getTime(),
    );
    expect(dated.getTime()).toBeGreaterThanOrEqual(
      feePurgeCutoff(
        middayOn("2028-12-31"),
        CALENDAR_YEAR_START_MONTH,
        2,
      ).getTime(),
    );
  });

  it("keeps seven years as the window in force", () => {
    // Stated on its own, because the number is the whole of the promise the
    // report makes and a change to it is a change to the product.
    expect(FEE_RETENTION_YEARS).toBe(7);
  });
});

import { dateColumnOf } from "@openbrf/shared";
import { describe, expect, it } from "vitest";

import { CALENDAR_YEAR_START_MONTH } from "../retention/financial-year";
import {
  computeMemberChargePurgeDate,
  MEMBER_CHARGE_RETENTION_YEARS,
  memberChargePurgeCutoff,
} from "./member-charge-retention";

/**
 * The charge retention window, read from both ends.
 *
 * The two functions answer opposite questions about one rule - "when is this
 * charge erased" and "which charges are past it" - and the product's promise is
 * that they agree. A disagreement means erasing on a day other than the one the
 * data subject access report stated, which is a promise broken rather than a bug
 * in a helper, so they are run against each other here rather than each being
 * checked against arithmetic that looks symmetrical.
 *
 * The arithmetic itself, including every case a broken financial year creates,
 * is asserted in `retention/financial-year.spec.ts`. What is asserted here is
 * this module's own promises: the window in force, the default that reproduces
 * what the product computed before it read a financial year at all, and the one
 * case a board would notice.
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

describe("computeMemberChargePurgeDate", () => {
  it("erases at the start of the eighth year after the financial year's own", () => {
    // Bokforingslagen 7 kap. 2 § preserves through the seventh year after the
    // calendar year the financial year closed, so a 2026 charge on the calendar
    // year is kept through 2033 and erasable on the first morning of 2034.
    expect(computeMemberChargePurgeDate(day("2026-03-05")).toISOString()).toBe(
      "2034-01-01T00:00:00.000Z",
    );
  });

  it("gives every charge in one financial year the same date", () => {
    // The reason for the window runs from the end of a calendar year, so a
    // January charge and a December one from the same books go together.
    expect(computeMemberChargePurgeDate(day("2026-01-01"))).toEqual(
      computeMemberChargePurgeDate(day("2026-12-31")),
    );
    // And on a broken year the pair that goes together is the one inside it.
    expect(computeMemberChargePurgeDate(day("2026-05-01"), MAY)).toEqual(
      computeMemberChargePurgeDate(day("2027-04-30"), MAY),
    );
  });

  it("keeps a charge in a broken year's first half a year longer", () => {
    /*
     * The whole of the correction, stated where a board would meet it. On a
     * year running from the 1st of May, a June charge falls in the year that
     * ends the following April and is preserved from the end of that later
     * year; a March charge falls in the year that ended that April. Anchoring
     * on the charge's own calendar year erased the first a full year early.
     */
    expect(
      computeMemberChargePurgeDate(day("2026-06-15"), MAY).toISOString(),
    ).toBe("2035-01-01T00:00:00.000Z");
    expect(
      computeMemberChargePurgeDate(day("2026-03-15"), MAY).toISOString(),
    ).toBe("2034-01-01T00:00:00.000Z");
  });

  it("computes what it computed before the financial year existed", () => {
    /*
     * The default is the calendar year, which is what every instance recorded
     * before the column existed had assumed. An omitted argument therefore
     * states the same erasure date a report already printed for those rows.
     */
    for (const text of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
      expect(computeMemberChargePurgeDate(day(text))).toEqual(
        computeMemberChargePurgeDate(day(text), CALENDAR_YEAR_START_MONTH),
      );
    }
  });

  it("reads the charge date as a calendar date and not as an instant", () => {
    /*
     * The recurring bug in this repository. A date column is read back as
     * midnight UTC, which is the evening before in Stockholm for part of the
     * year - so a purge date derived by reading the local fields off that
     * instant would put a New Year's Eve charge in the previous year's cohort
     * and erase it a year early.
     */
    expect(computeMemberChargePurgeDate(day("2026-12-31")).toISOString()).toBe(
      "2034-01-01T00:00:00.000Z",
    );
    expect(computeMemberChargePurgeDate(day("2027-01-01")).toISOString()).toBe(
      "2035-01-01T00:00:00.000Z",
    );
  });

  it("refuses a window that is not a number of years", () => {
    expect(() =>
      computeMemberChargePurgeDate(
        day("2026-03-05"),
        CALENDAR_YEAR_START_MONTH,
        Number.NaN,
      ),
    ).toThrow(RangeError);
    expect(() =>
      computeMemberChargePurgeDate(
        day("2026-03-05"),
        CALENDAR_YEAR_START_MONTH,
        -1,
      ),
    ).toThrow(RangeError);
    // Refused rather than rounded: half a calendar year is not a thing to
    // anchor on, and rounding it would erase a year off what was asked for
    // without saying so.
    expect(() =>
      computeMemberChargePurgeDate(
        day("2026-03-05"),
        CALENDAR_YEAR_START_MONTH,
        6.5,
      ),
    ).toThrow(RangeError);
  });

  it("refuses a financial year starting in a month no year has", () => {
    expect(() => computeMemberChargePurgeDate(day("2026-03-05"), 0)).toThrow(
      RangeError,
    );
    expect(() => computeMemberChargePurgeDate(day("2026-03-05"), 13)).toThrow(
      RangeError,
    );
  });
});

describe("memberChargePurgeCutoff", () => {
  it("takes the year from the association's own calendar", () => {
    /*
     * Half past midnight on New Year's Day in Stockholm is still the 31st of
     * December in UTC. A run at that moment is running in the new year, so the
     * cohort that has just fallen out is the one this asserts - reading the year
     * off the UTC instant would leave it in place for another day.
     */
    expect(
      memberChargePurgeCutoff(
        new Date("2034-01-01T00:30:00.000+01:00"),
      ).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
  });

  it("cuts at the start of a financial year on a broken one", () => {
    expect(
      memberChargePurgeCutoff(middayOn("2034-06-01"), MAY).toISOString(),
    ).toBe("2026-05-01T00:00:00.000Z");
  });

  it("refuses a window that is not a number of years", () => {
    expect(() =>
      memberChargePurgeCutoff(
        middayOn("2034-06-01"),
        CALENDAR_YEAR_START_MONTH,
        Number.NaN,
      ),
    ).toThrow(RangeError);
    expect(() =>
      memberChargePurgeCutoff(
        middayOn("2034-06-01"),
        CALENDAR_YEAR_START_MONTH,
        6.5,
      ),
    ).toThrow(RangeError);
  });
});

describe("the two agree", () => {
  it.each([
    "2026-01-01",
    "2026-03-05",
    "2026-12-31",
    "2027-07-15",
    "2030-02-29",
  ])("a charge dated %s is erasable exactly from its stated date", (text) => {
    const chargedOn = day(text);
    const purgeOn = computeMemberChargePurgeDate(chargedOn);
    const purgeDay = purgeOn.toISOString().slice(0, 10);

    // On the stated day the scan reaches it.
    const onTheDay = memberChargePurgeCutoff(middayOn(purgeDay));
    expect(chargedOn.getTime()).toBeLessThan(onTheDay.getTime());

    // The day before, it does not.
    const before = new Date(purgeOn.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const dayBefore = memberChargePurgeCutoff(middayOn(before));
    expect(chargedOn.getTime()).toBeGreaterThanOrEqual(dayBefore.getTime());
  });

  it("keeps that agreement on a broken financial year", () => {
    const chargedOn = day("2026-06-15");
    const purgeOn = computeMemberChargePurgeDate(chargedOn, MAY);
    expect(chargedOn.getTime()).toBeLessThan(
      memberChargePurgeCutoff(
        middayOn(purgeOn.toISOString().slice(0, 10)),
        MAY,
      ).getTime(),
    );
    expect(chargedOn.getTime()).toBeGreaterThanOrEqual(
      memberChargePurgeCutoff(
        middayOn(
          new Date(purgeOn.getTime() - 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        ),
        MAY,
      ).getTime(),
    );
  });

  it("keeps that agreement when the window is shortened", () => {
    /*
     * The window is a constant the product may shorten without a migration,
     * because every date is derived. A shortening that moved one function and
     * not the other would erase on a day no report had ever stated, so both are
     * driven with the same non-default value.
     */
    const chargedOn = day("2026-06-01");
    const purgeOn = computeMemberChargePurgeDate(
      chargedOn,
      CALENDAR_YEAR_START_MONTH,
      2,
    );
    expect(purgeOn.toISOString()).toBe("2029-01-01T00:00:00.000Z");
    expect(chargedOn.getTime()).toBeLessThan(
      memberChargePurgeCutoff(
        middayOn("2029-01-01"),
        CALENDAR_YEAR_START_MONTH,
        2,
      ).getTime(),
    );
    expect(chargedOn.getTime()).toBeGreaterThanOrEqual(
      memberChargePurgeCutoff(
        middayOn("2028-12-31"),
        CALENDAR_YEAR_START_MONTH,
        2,
      ).getTime(),
    );
  });

  it("keeps seven years as the window in force", () => {
    // Stated on its own, because the number is the whole of the promise the
    // report makes and a change to it is a change to the product.
    expect(MEMBER_CHARGE_RETENTION_YEARS).toBe(7);
  });
});

import { describe, expect, it } from "vitest";

import { dateColumnOf } from "../bookings/stockholm-calendar";
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

describe("computeMemberChargePurgeDate", () => {
  it("erases at the start of the eighth year after the charge's own", () => {
    // Bokforingslagen 7 kap. 2 § preserves through the seventh year after the
    // calendar year the financial year closed, so a 2026 charge is kept through
    // 2033 and erasable on the first morning of 2034.
    expect(computeMemberChargePurgeDate(day("2026-03-05")).toISOString()).toBe(
      "2034-01-01T00:00:00.000Z",
    );
  });

  it("gives every charge in one year the same date", () => {
    // The reason for the window runs from the end of a calendar year, so a
    // January charge and a December one from the same books go together.
    expect(computeMemberChargePurgeDate(day("2026-01-01"))).toEqual(
      computeMemberChargePurgeDate(day("2026-12-31")),
    );
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
      computeMemberChargePurgeDate(day("2026-03-05"), Number.NaN),
    ).toThrow(RangeError);
    expect(() => computeMemberChargePurgeDate(day("2026-03-05"), -1)).toThrow(
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

  it("refuses a window that is not a number of years", () => {
    expect(() =>
      memberChargePurgeCutoff(middayOn("2034-06-01"), Number.NaN),
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

  it("keeps that agreement when the window is shortened", () => {
    /*
     * The window is a constant the product may shorten without a migration,
     * because every date is derived. A shortening that moved one function and
     * not the other would erase on a day no report had ever stated, so both are
     * driven with the same non-default value.
     */
    const chargedOn = day("2026-06-01");
    const purgeOn = computeMemberChargePurgeDate(chargedOn, 2);
    expect(purgeOn.toISOString()).toBe("2029-01-01T00:00:00.000Z");
    expect(chargedOn.getTime()).toBeLessThan(
      memberChargePurgeCutoff(middayOn("2029-01-01"), 2).getTime(),
    );
    expect(chargedOn.getTime()).toBeGreaterThanOrEqual(
      memberChargePurgeCutoff(middayOn("2028-12-31"), 2).getTime(),
    );
  });

  it("keeps seven years as the window in force", () => {
    // Stated on its own, because the number is the whole of the promise the
    // report makes and a change to it is a change to the product.
    expect(MEMBER_CHARGE_RETENTION_YEARS).toBe(7);
  });
});

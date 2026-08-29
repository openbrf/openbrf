import { describe, expect, it } from "vitest";

import { computePurgeDate } from "./purge-date";
import { purgeCutoff } from "./purge-window";

const RETENTION_DAYS = 365;

/**
 * The cutoff and the displayed purge date are one decision read from two ends.
 *
 * The register screens compute a date per residency and promise it to a person
 * who moved out. The job compares every move-out date against one cutoff. If
 * the two ever disagree the product erases data on a day other than the one it
 * said it would, so the agreement is asserted here rather than assumed from the
 * arithmetic looking symmetrical.
 */
describe("purgeCutoff", () => {
  it("is the move-out date whose purge date is exactly now", () => {
    const now = new Date("2027-08-01T00:00:00.000Z");

    const cutoff = purgeCutoff(now, RETENTION_DAYS);

    expect(computePurgeDate(cutoff, RETENTION_DAYS)?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the displayed purge date on both sides of the line", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");
    const cutoff = purgeCutoff(now, RETENTION_DAYS);

    const dueYesterday = new Date("2026-07-31T00:00:00.000Z");
    const dueTomorrow = new Date("2026-08-02T00:00:00.000Z");

    // Eligible exactly when the date the screens show has arrived.
    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      (computePurgeDate(dueYesterday, RETENTION_DAYS)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      (computePurgeDate(dueTomorrow, RETENTION_DAYS)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(false);
  });

  it("moves every pending eligibility when the policy is shortened", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    const strict = purgeCutoff(now, 30);
    const generous = purgeCutoff(now, 3650);

    // A shorter policy reaches move-outs closer to today; a longer one only
    // reaches older ones. The date is derived, so this needs no migration.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("purges everything already moved out at a zero-day policy", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    expect(purgeCutoff(now, 0).toISOString()).toBe(now.toISOString());
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. A cutoff a day
    // early is an erasure a day early, on data the register promised a later
    // date for.
    const now = new Date("2026-10-31T00:00:00.000Z");

    expect(purgeCutoff(now, 30).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("refuses a negative policy rather than reaching into the future", () => {
    // A negative policy would put the cutoff after today and erase data whose
    // retention has not run out. Refused for the same reason computePurgeDate
    // refuses it.
    expect(() => purgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a policy that is not a number of days", () => {
    expect(() => purgeCutoff(new Date(), Number.NaN)).toThrow(RangeError);
  });
});

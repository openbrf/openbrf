import { describe, expect, it } from "vitest";

import { computePurgeDate } from "./purge-date";

const MOVED_OUT = new Date("2026-08-01T00:00:00.000Z");

describe("computePurgeDate", () => {
  it("anchors on the move-out date plus the retention policy", () => {
    expect(computePurgeDate(MOVED_OUT, 365)?.toISOString()).toBe(
      "2027-08-01T00:00:00.000Z",
    );
  });

  it("has no purge date while the residency is current", () => {
    // Not a date far in the future: there is nothing to purge, and a placeholder
    // date would eventually arrive and be acted on.
    expect(computePurgeDate(null, 365)).toBeNull();
  });

  it("recomputes when the association shortens its retention policy", () => {
    // The date is derived, never stored, so a policy change moves every pending
    // purge date by that act alone. This is what makes phase 1's "compute and
    // display" honest without a migration job.
    const before = computePurgeDate(MOVED_OUT, 730);
    const after = computePurgeDate(MOVED_OUT, 180);

    expect(before?.toISOString()).toBe("2028-07-31T00:00:00.000Z");
    expect(after?.toISOString()).toBe("2027-01-28T00:00:00.000Z");
  });

  it("recomputes when the association lengthens its retention policy", () => {
    const shorter = computePurgeDate(MOVED_OUT, 365);
    const longer = computePurgeDate(MOVED_OUT, 365 * 2);

    expect(longer?.getTime()).toBeGreaterThan(shorter?.getTime() ?? 0);
  });

  it("purges immediately at a zero-day policy", () => {
    expect(computePurgeDate(MOVED_OUT, 0)?.toISOString()).toBe(
      MOVED_OUT.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date a
    // day early is an erasure a day early.
    const octoberMoveOut = new Date("2026-10-01T00:00:00.000Z");

    expect(computePurgeDate(octoberMoveOut, 30)?.toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative policy rather than computing a date in the past", () => {
    expect(() => computePurgeDate(MOVED_OUT, -1)).toThrow(RangeError);
  });

  it("refuses a policy that is not a number of days", () => {
    expect(() => computePurgeDate(MOVED_OUT, Number.NaN)).toThrow(RangeError);
  });
});

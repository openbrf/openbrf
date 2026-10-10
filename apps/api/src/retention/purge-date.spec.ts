import { describe, expect, it } from "vitest";

import { computePersonPurgeDate, computePurgeDate } from "./purge-date";

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

describe("computePersonPurgeDate", () => {
  const NOW = new Date("2026-09-01T00:00:00.000Z");
  const NOTHING = {
    residencies: [],
    boardPositions: [],
    systemRoles: 0,
    withheld: false,
  };

  it("anchors on the last residency to end, not on each of them", () => {
    // Moved from one apartment to another two years apart: the first row's date
    // is long past, and the purge does not act on it.
    const person = {
      ...NOTHING,
      residencies: [
        { movedOutOn: new Date("2024-03-01T00:00:00.000Z") },
        { movedOutOn: new Date("2026-08-01T00:00:00.000Z") },
      ],
    };

    expect(computePersonPurgeDate(person, 365, NOW)?.toISOString()).toBe(
      "2027-08-01T00:00:00.000Z",
    );
  });

  it("has no date while a residency is still running", () => {
    const person = {
      ...NOTHING,
      residencies: [
        { movedOutOn: new Date("2024-03-01T00:00:00.000Z") },
        { movedOutOn: null },
      ],
    };

    expect(computePersonPurgeDate(person, 365, NOW)).toBeNull();
  });

  it("has no date while the only move-out is scheduled for a day to come", () => {
    // The person is resident until that day, and the purge leaves them alone.
    const person = {
      ...NOTHING,
      residencies: [{ movedOutOn: new Date("2026-09-15T00:00:00.000Z") }],
    };

    expect(computePersonPurgeDate(person, 365, NOW)).toBeNull();
  });

  it("reads a move-out dated today as having happened, on the association's day", () => {
    // 23:30 UTC on 31 August is already 1 September in Stockholm.
    const lateEvening = new Date("2026-08-31T23:30:00.000Z");
    const person = {
      ...NOTHING,
      residencies: [{ movedOutOn: new Date("2026-09-01T00:00:00.000Z") }],
    };

    expect(
      computePersonPurgeDate(person, 365, lateEvening)?.toISOString(),
    ).toBe("2027-09-01T00:00:00.000Z");
  });

  it("has no date for somebody with no residency", () => {
    expect(computePersonPurgeDate(NOTHING, 365, NOW)).toBeNull();
  });

  it.each([
    ["a legal hold or a restriction", { withheld: true }],
    ["a system role", { systemRoles: 1 }],
    ["a board seat with no end", { boardPositions: [{ endedOn: null }] }],
    [
      "a board seat that ends later",
      { boardPositions: [{ endedOn: new Date("2026-12-01T00:00:00.000Z") }] },
    ],
  ])("has no date while %s stands", (_name, standing) => {
    const person = {
      ...NOTHING,
      residencies: [{ movedOutOn: new Date("2024-03-01T00:00:00.000Z") }],
      ...standing,
    };

    expect(computePersonPurgeDate(person, 365, NOW)).toBeNull();
  });

  it("has a date once a board seat has ended", () => {
    const person = {
      ...NOTHING,
      residencies: [{ movedOutOn: new Date("2024-03-01T00:00:00.000Z") }],
      boardPositions: [{ endedOn: new Date("2025-01-01T00:00:00.000Z") }],
    };

    expect(computePersonPurgeDate(person, 365, NOW)?.toISOString()).toBe(
      "2025-03-01T00:00:00.000Z",
    );
  });
});

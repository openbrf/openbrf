import { describe, expect, it } from "vitest";

import {
  ISSUE_RETENTION_DAYS,
  computeIssuePurgeDate,
  issuePurgeCutoff,
} from "./issue-retention";

const CLOSED = new Date("2026-08-01T12:00:00.000Z");

describe("computeIssuePurgeDate", () => {
  it("anchors on the day the issue was closed plus the retention window", () => {
    expect(computeIssuePurgeDate(CLOSED, 365)?.toISOString()).toBe(
      "2027-08-01T12:00:00.000Z",
    );
  });

  it("has no purge date at all while the issue is open", () => {
    // Not a date far in the future: the association is still working on the
    // problem and still needs to be able to answer whoever reported it.
    expect(computeIssuePurgeDate(null, 365)).toBeNull();
  });

  it("defaults to the module's retention window", () => {
    expect(computeIssuePurgeDate(CLOSED)?.toISOString()).toBe(
      computeIssuePurgeDate(CLOSED, ISSUE_RETENTION_DAYS)?.toISOString(),
    );
  });

  it("recomputes when the window is shortened", () => {
    expect(computeIssuePurgeDate(CLOSED, 30)?.toISOString()).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    const octoberClose = new Date("2026-10-01T00:00:00.000Z");

    expect(computeIssuePurgeDate(octoberClose, 30)?.toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeIssuePurgeDate(CLOSED, -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => computeIssuePurgeDate(CLOSED, Number.NaN)).toThrow(RangeError);
  });

  it("refuses a bad window even while the issue is open", () => {
    // The null return is about the issue, not about the argument: a caller
    // passing nonsense should hear about it whether or not the row is closed.
    expect(() => computeIssuePurgeDate(null, -1)).toThrow(RangeError);
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends, and
 * the agreement is asserted rather than assumed: the access report states a
 * date per issue, and the job compares every issue's closing against one
 * cutoff. If they disagree the product erases on a day other than the one it
 * stated.
 */
describe("issuePurgeCutoff", () => {
  it("is the closing date whose purge date is exactly now", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    const cutoff = issuePurgeCutoff(now, 365);

    expect(computeIssuePurgeDate(cutoff, 365)?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");
    const cutoff = issuePurgeCutoff(now, 365);

    const dueYesterday = new Date("2026-07-31T12:00:00.000Z");
    const dueTomorrow = new Date("2026-08-02T12:00:00.000Z");

    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      (computeIssuePurgeDate(dueYesterday, 365)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      (computeIssuePurgeDate(dueTomorrow, 365)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    expect(issuePurgeCutoff(now).toISOString()).toBe(
      issuePurgeCutoff(now, ISSUE_RETENTION_DAYS).toISOString(),
    );
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => issuePurgeCutoff(new Date(), Number.NaN)).toThrow(RangeError);
  });
});

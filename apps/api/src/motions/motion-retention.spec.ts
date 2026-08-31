import { describe, expect, it } from "vitest";

import {
  computeMotionPurgeDate,
  MOTION_RETENTION_DAYS,
  motionPurgeCutoff,
} from "./motion-retention";

const CLOSED = new Date("2027-04-15T12:00:00.000Z");

describe("computeMotionPurgeDate", () => {
  it("anchors on the closing date plus the retention window", () => {
    expect(computeMotionPurgeDate(CLOSED, 730)?.toISOString()).toBe(
      "2029-04-14T12:00:00.000Z",
    );
  });

  it("states no date for a motion still with the board", () => {
    /*
     * The load-bearing case of this file. An open motion has no closing date to
     * count from, and the association is still processing it, so no purge date
     * exists - and a function that answered "now plus the window" here would put
     * an erasure date on a member's access report for an item nobody has dealt
     * with yet, and the purge would then be entitled to erase it.
     */
    expect(computeMotionPurgeDate(null, 730)).toBeNull();
  });

  it("defaults to the module's retention window", () => {
    expect(computeMotionPurgeDate(CLOSED)?.toISOString()).toBe(
      computeMotionPurgeDate(CLOSED, MOTION_RETENTION_DAYS)?.toISOString(),
    );
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration and no recomputation
    // job, and the access report states the date that will actually apply.
    expect(computeMotionPurgeDate(CLOSED, 30)?.toISOString()).toBe(
      "2027-05-15T12:00:00.000Z",
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date a
    // day early is an erasure before the date the report stated.
    const octoberClose = new Date("2027-10-01T00:00:00.000Z");

    expect(computeMotionPurgeDate(octoberClose, 30)?.toISOString()).toBe(
      "2027-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeMotionPurgeDate(CLOSED, -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => computeMotionPurgeDate(CLOSED, Number.NaN)).toThrow(
      RangeError,
    );
  });

  it("refuses a bad window even for an open motion", () => {
    // The null branch must not be a way past the guard: a caller passing a
    // nonsense window would otherwise be told nothing is wrong.
    expect(() => computeMotionPurgeDate(null, -1)).toThrow(RangeError);
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per motion and hands it to the person the
 * motion is about. The job compares every closing date against one cutoff. If
 * the two ever disagree the product erases on a day other than the one it stated,
 * so the agreement is asserted here rather than assumed from the arithmetic
 * looking symmetrical.
 */
describe("motionPurgeCutoff", () => {
  it("is the closing time whose purge date is exactly now", () => {
    const now = new Date("2029-04-14T12:00:00.000Z");

    const cutoff = motionPurgeCutoff(now, 730);

    expect(computeMotionPurgeDate(cutoff, 730)?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2029-04-14T12:00:00.000Z");
    const cutoff = motionPurgeCutoff(now, 730);

    const dueYesterday = new Date("2027-04-14T12:00:00.000Z");
    const dueTomorrow = new Date("2027-04-16T12:00:00.000Z");

    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      (computeMotionPurgeDate(dueYesterday, 730)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      (computeMotionPurgeDate(dueTomorrow, 730)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2029-04-14T12:00:00.000Z");

    expect(motionPurgeCutoff(now).toISOString()).toBe(
      motionPurgeCutoff(now, MOTION_RETENTION_DAYS).toISOString(),
    );
  });

  it("outlives one full annual cycle after the motion closed", () => {
    /*
     * The reason the window is two years and not one. A motion is dealt with at
     * one annual meeting, and the meeting where a member asks what came of it is
     * the one after that - so a motion closed at last spring's meeting has to
     * still be there at the next one, and at a meeting held a little late.
     */
    const closedAtAMeeting = new Date("2027-05-20T18:00:00.000Z");
    const nextYearsMeeting = new Date("2028-06-10T18:00:00.000Z");

    expect(
      closedAtAMeeting.getTime() <=
        motionPurgeCutoff(nextYearsMeeting, MOTION_RETENTION_DAYS).getTime(),
    ).toBe(false);
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2029-01-01T00:00:00.000Z");

    const strict = motionPurgeCutoff(now, 30);
    const generous = motionPurgeCutoff(now, 3650);

    // A shorter window reaches motions closed closer to today; a longer one only
    // reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase motions whose
    // retention had not run out.
    expect(() => motionPurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => motionPurgeCutoff(new Date(), Number.NaN)).toThrow(RangeError);
  });
});

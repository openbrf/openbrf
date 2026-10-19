import { describe, expect, it } from "vite-plus/test";

import {
  FEED_RETENTION_DAYS,
  computeFeedPurgeDate,
  feedPurgeCutoff,
} from "./feed-retention";

const WRITTEN = new Date("2026-08-01T12:00:00.000Z");

describe("computeFeedPurgeDate", () => {
  it("anchors on when the post or comment was written plus the retention window", () => {
    expect(computeFeedPurgeDate(WRITTEN, 365).toISOString()).toBe(
      "2027-08-01T12:00:00.000Z",
    );
  });

  it("defaults to the module's retention window", () => {
    expect(computeFeedPurgeDate(WRITTEN).toISOString()).toBe(
      computeFeedPurgeDate(WRITTEN, FEED_RETENTION_DAYS).toISOString(),
    );
  });

  it("gives each post in an audience its own date", () => {
    /*
     * The anchor is the post and deliberately not the audience. A feed has no
     * end, so anchoring on the newest post would mean a group somebody writes
     * in every week purges nothing, ever - the audience would empty from
     * neither end.
     */
    const winter = new Date("2026-01-15T09:00:00.000Z");
    const summer = new Date("2026-07-15T09:00:00.000Z");

    expect(computeFeedPurgeDate(winter, 365).getTime()).toBeLessThan(
      computeFeedPurgeDate(summer, 365).getTime(),
    );
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration, no recomputation
    // job, and the access report states the date that will actually apply.
    expect(computeFeedPurgeDate(WRITTEN, 30).toISOString()).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });

  it("erases as soon as the post is written at a zero-day window", () => {
    expect(computeFeedPurgeDate(WRITTEN, 0).toISOString()).toBe(
      WRITTEN.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date an
    // hour early is an erasure before the date the report stated.
    const octoberWrite = new Date("2026-10-01T00:00:00.000Z");

    expect(computeFeedPurgeDate(octoberWrite, 30).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeFeedPurgeDate(WRITTEN, -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => computeFeedPurgeDate(WRITTEN, Number.NaN)).toThrow(RangeError);
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per post and per comment and hands it to the
 * person who wrote it. The job compares every row's writing time against one
 * cutoff. If the two ever disagree the product erases on a day other than the
 * one it stated, so the agreement is asserted here rather than assumed from the
 * arithmetic looking symmetrical.
 */
describe("feedPurgeCutoff", () => {
  it("is the writing time whose purge date is exactly now", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    const cutoff = feedPurgeCutoff(now, 365);

    expect(computeFeedPurgeDate(cutoff, 365).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");
    const cutoff = feedPurgeCutoff(now, 365);

    const dueYesterday = new Date("2026-07-31T12:00:00.000Z");
    const dueTomorrow = new Date("2026-08-02T12:00:00.000Z");

    // Erasable exactly when the date the report stated has arrived.
    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      computeFeedPurgeDate(dueYesterday, 365).getTime() <= now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      computeFeedPurgeDate(dueTomorrow, 365).getTime() <= now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    expect(feedPurgeCutoff(now).toISOString()).toBe(
      feedPurgeCutoff(now, FEED_RETENTION_DAYS).toISOString(),
    );
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    const strict = feedPurgeCutoff(now, 30);
    const generous = feedPurgeCutoff(now, 3650);

    // A shorter window reaches posts and comments written closer to today; a
    // longer one only reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("reaches everything already written at a zero-day window", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    expect(feedPurgeCutoff(now, 0).toISOString()).toBe(now.toISOString());
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    const now = new Date("2026-10-31T00:00:00.000Z");

    expect(feedPurgeCutoff(now, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase posts and
    // comments whose retention had not run out.
    expect(() => feedPurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => feedPurgeCutoff(new Date(), Number.NaN)).toThrow(RangeError);
  });
});

/**
 * Posts and comments are kept for the same span, deliberately - one window, as
 * the chat's and the news thread's already were.
 *
 * Both are service-tier records of what one person wrote to the others who live
 * here, and two different windows would be two answers to one question nobody
 * asked. Asserted rather than left as a coincidence the code could drift out
 * of.
 */
describe("the window itself", () => {
  it("is a year", () => {
    expect(FEED_RETENTION_DAYS).toBe(365);
  });
});

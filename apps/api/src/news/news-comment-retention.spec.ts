import { describe, expect, it } from "vitest";

import {
  NEWS_COMMENT_RETENTION_DAYS,
  computeNewsCommentPurgeDate,
  newsCommentPurgeCutoff,
} from "./news-comment-retention";

const WRITTEN = new Date("2026-08-01T12:00:00.000Z");

describe("computeNewsCommentPurgeDate", () => {
  it("anchors on when the comment was written plus the retention window", () => {
    expect(computeNewsCommentPurgeDate(WRITTEN, 365).toISOString()).toBe(
      "2027-08-01T12:00:00.000Z",
    );
  });

  it("defaults to the module's retention window", () => {
    expect(computeNewsCommentPurgeDate(WRITTEN).toISOString()).toBe(
      computeNewsCommentPurgeDate(
        WRITTEN,
        NEWS_COMMENT_RETENTION_DAYS,
      ).toISOString(),
    );
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration, no recomputation
    // job, and the access report states the date that will actually apply.
    expect(computeNewsCommentPurgeDate(WRITTEN, 30).toISOString()).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });

  it("erases as soon as the comment is written at a zero-day window", () => {
    expect(computeNewsCommentPurgeDate(WRITTEN, 0).toISOString()).toBe(
      WRITTEN.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date
    // early is an erasure before the date the report stated.
    const octoberWrite = new Date("2026-10-01T00:00:00.000Z");

    expect(computeNewsCommentPurgeDate(octoberWrite, 30).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeNewsCommentPurgeDate(WRITTEN, -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => computeNewsCommentPurgeDate(WRITTEN, Number.NaN)).toThrow(
      RangeError,
    );
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per comment and hands it to the person who
 * wrote it. The job compares every comment's writing time against one cutoff. If
 * the two ever disagree the product erases on a day other than the one it
 * stated, so the agreement is asserted here rather than assumed from the
 * arithmetic looking symmetrical.
 */
describe("newsCommentPurgeCutoff", () => {
  it("is the writing time whose purge date is exactly now", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    const cutoff = newsCommentPurgeCutoff(now, 365);

    expect(computeNewsCommentPurgeDate(cutoff, 365).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");
    const cutoff = newsCommentPurgeCutoff(now, 365);

    const dueYesterday = new Date("2026-07-31T12:00:00.000Z");
    const dueTomorrow = new Date("2026-08-02T12:00:00.000Z");

    // Erasable exactly when the date the report stated has arrived.
    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      computeNewsCommentPurgeDate(dueYesterday, 365).getTime() <= now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      computeNewsCommentPurgeDate(dueTomorrow, 365).getTime() <= now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    expect(newsCommentPurgeCutoff(now).toISOString()).toBe(
      newsCommentPurgeCutoff(now, NEWS_COMMENT_RETENTION_DAYS).toISOString(),
    );
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    const strict = newsCommentPurgeCutoff(now, 30);
    const generous = newsCommentPurgeCutoff(now, 3650);

    // A shorter window reaches comments written closer to today; a longer one
    // only reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("reaches everything already written at a zero-day window", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    expect(newsCommentPurgeCutoff(now, 0).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    const now = new Date("2026-10-31T00:00:00.000Z");

    expect(newsCommentPurgeCutoff(now, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase comments whose
    // retention had not run out.
    expect(() => newsCommentPurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => newsCommentPurgeCutoff(new Date(), Number.NaN)).toThrow(
      RangeError,
    );
  });
});

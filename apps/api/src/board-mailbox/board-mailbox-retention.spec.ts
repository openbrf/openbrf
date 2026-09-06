import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BOARD_MAILBOX_RETENTION_DAYS,
  boardMailboxPurgeCutoff,
  computeBoardMailboxPurgeDate,
} from "./board-mailbox-retention";

const LAST_MESSAGE = new Date("2026-08-01T12:00:00.000Z");

/**
 * The daylight saving cases run on the association's own clock.
 *
 * Without this they run on the container's, which is UTC, where calendar-field
 * arithmetic and instant arithmetic give the same answer - so the two assertions
 * about a daylight saving boundary would pass through the regression they exist
 * for. Europe/Stockholm is where the two disagree, and it is the zone the
 * product's dates are stated in.
 */
const CONTAINER_TIME_ZONE = process.env["TZ"];

beforeAll(() => {
  process.env["TZ"] = "Europe/Stockholm";
});

afterAll(() => {
  if (CONTAINER_TIME_ZONE === undefined) {
    delete process.env["TZ"];
  } else {
    process.env["TZ"] = CONTAINER_TIME_ZONE;
  }
});

describe("computeBoardMailboxPurgeDate", () => {
  it("anchors on the newest message plus the retention window", () => {
    expect(computeBoardMailboxPurgeDate(LAST_MESSAGE, 730).toISOString()).toBe(
      "2028-07-31T12:00:00.000Z",
    );
  });

  it("defaults to the module's retention window", () => {
    expect(computeBoardMailboxPurgeDate(LAST_MESSAGE).toISOString()).toBe(
      computeBoardMailboxPurgeDate(
        LAST_MESSAGE,
        BOARD_MAILBOX_RETENTION_DAYS,
      ).toISOString(),
    );
  });

  it("restarts the window when the conversation carries on", () => {
    // The anchor is the last message rather than the first, which is the one
    // place this differs from the news comment window. A comment is one thing
    // somebody said; a thread is a conversation, and one the board answered last
    // month is not two years old because it opened two years ago.
    const opened = new Date("2026-08-01T12:00:00.000Z");
    const answered = new Date("2026-09-15T12:00:00.000Z");

    expect(
      computeBoardMailboxPurgeDate(answered, 730).getTime(),
    ).toBeGreaterThan(computeBoardMailboxPurgeDate(opened, 730).getTime());
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration, no recomputation job,
    // and the access report states the date that will actually apply.
    expect(computeBoardMailboxPurgeDate(LAST_MESSAGE, 30).toISOString()).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });

  it("erases as soon as the message arrived at a zero-day window", () => {
    expect(computeBoardMailboxPurgeDate(LAST_MESSAGE, 0).toISOString()).toBe(
      LAST_MESSAGE.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date an
    // hour early is still an erasure before the date the report stated.
    const october = new Date("2026-10-01T00:00:00.000Z");

    expect(computeBoardMailboxPurgeDate(october, 30).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeBoardMailboxPurgeDate(LAST_MESSAGE, -1)).toThrow(
      RangeError,
    );
  });

  it("refuses a window that is not a number of days", () => {
    expect(() =>
      computeBoardMailboxPurgeDate(LAST_MESSAGE, Number.NaN),
    ).toThrow(RangeError);
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per thread and hands it to the person whose
 * address the correspondence is with. The job compares every thread's last
 * message against one cutoff. If the two ever disagree the product erases on a
 * day other than the one it stated, so the agreement is asserted here rather
 * than assumed from the arithmetic looking symmetrical.
 */
describe("boardMailboxPurgeCutoff", () => {
  it("is the last-message time whose purge date is exactly now", () => {
    const now = new Date("2028-07-31T12:00:00.000Z");

    const cutoff = boardMailboxPurgeCutoff(now, 730);

    expect(computeBoardMailboxPurgeDate(cutoff, 730).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2028-07-31T12:00:00.000Z");
    const cutoff = boardMailboxPurgeCutoff(now, 730);

    const dueYesterday = new Date("2026-07-31T12:00:00.000Z");
    const dueTomorrow = new Date("2026-08-02T12:00:00.000Z");

    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      computeBoardMailboxPurgeDate(dueYesterday, 730).getTime() <=
        now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      computeBoardMailboxPurgeDate(dueTomorrow, 730).getTime() <= now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2028-07-31T12:00:00.000Z");

    expect(boardMailboxPurgeCutoff(now).toISOString()).toBe(
      boardMailboxPurgeCutoff(now, BOARD_MAILBOX_RETENTION_DAYS).toISOString(),
    );
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2028-01-01T00:00:00.000Z");

    const strict = boardMailboxPurgeCutoff(now, 30);
    const generous = boardMailboxPurgeCutoff(now, 3650);

    // A shorter window reaches threads that went quiet closer to today; a longer
    // one only reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("reaches every thread already quiet at a zero-day window", () => {
    const now = new Date("2028-01-01T00:00:00.000Z");

    expect(boardMailboxPurgeCutoff(now, 0).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    const now = new Date("2026-10-31T00:00:00.000Z");

    expect(boardMailboxPurgeCutoff(now, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase threads whose
    // retention had not run out.
    expect(() => boardMailboxPurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => boardMailboxPurgeCutoff(new Date(), Number.NaN)).toThrow(
      RangeError,
    );
  });
});

describe("BOARD_MAILBOX_RETENTION_DAYS", () => {
  it("is longer than the window a news comment gets", () => {
    // Deliberately, and the reason is in the module comment: what the board
    // keeps here is what the association was asked and what it answered, and the
    // questions a board is asked recur on the association's own annual cycle. A
    // one-year window would erase last spring's answer before this spring's
    // question arrives.
    expect(BOARD_MAILBOX_RETENTION_DAYS).toBe(730);
  });
});

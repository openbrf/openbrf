import { describe, expect, it } from "vitest";

import {
  CHAT_MESSAGE_RETENTION_DAYS,
  chatMessagePurgeCutoff,
  computeChatMessagePurgeDate,
} from "./chat-retention";

const WRITTEN = new Date("2026-08-01T12:00:00.000Z");

describe("computeChatMessagePurgeDate", () => {
  it("anchors on when the message was written plus the retention window", () => {
    expect(computeChatMessagePurgeDate(WRITTEN, 365).toISOString()).toBe(
      "2027-08-01T12:00:00.000Z",
    );
  });

  it("defaults to the module's retention window", () => {
    expect(computeChatMessagePurgeDate(WRITTEN).toISOString()).toBe(
      computeChatMessagePurgeDate(
        WRITTEN,
        CHAT_MESSAGE_RETENTION_DAYS,
      ).toISOString(),
    );
  });

  it("gives each message in a room its own date", () => {
    /*
     * The anchor is the message and deliberately not the room. A chat has no
     * end, so anchoring on the newest message would mean a board chat somebody
     * writes in every week purges nothing, ever - the room would empty from
     * neither end.
     */
    const winter = new Date("2026-01-15T09:00:00.000Z");
    const summer = new Date("2026-07-15T09:00:00.000Z");

    expect(computeChatMessagePurgeDate(winter, 365).getTime()).toBeLessThan(
      computeChatMessagePurgeDate(summer, 365).getTime(),
    );
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration, no recomputation
    // job, and the access report states the date that will actually apply.
    expect(computeChatMessagePurgeDate(WRITTEN, 30).toISOString()).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });

  it("erases as soon as the message is written at a zero-day window", () => {
    expect(computeChatMessagePurgeDate(WRITTEN, 0).toISOString()).toBe(
      WRITTEN.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date an
    // hour early is an erasure before the date the report stated.
    const octoberWrite = new Date("2026-10-01T00:00:00.000Z");

    expect(computeChatMessagePurgeDate(octoberWrite, 30).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeChatMessagePurgeDate(WRITTEN, -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => computeChatMessagePurgeDate(WRITTEN, Number.NaN)).toThrow(
      RangeError,
    );
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per message and hands it to the person who
 * wrote it. The job compares every message's writing time against one cutoff. If
 * the two ever disagree the product erases on a day other than the one it
 * stated, so the agreement is asserted here rather than assumed from the
 * arithmetic looking symmetrical.
 */
describe("chatMessagePurgeCutoff", () => {
  it("is the writing time whose purge date is exactly now", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    const cutoff = chatMessagePurgeCutoff(now, 365);

    expect(computeChatMessagePurgeDate(cutoff, 365).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");
    const cutoff = chatMessagePurgeCutoff(now, 365);

    const dueYesterday = new Date("2026-07-31T12:00:00.000Z");
    const dueTomorrow = new Date("2026-08-02T12:00:00.000Z");

    // Erasable exactly when the date the report stated has arrived.
    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      computeChatMessagePurgeDate(dueYesterday, 365).getTime() <= now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      computeChatMessagePurgeDate(dueTomorrow, 365).getTime() <= now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    expect(chatMessagePurgeCutoff(now).toISOString()).toBe(
      chatMessagePurgeCutoff(now, CHAT_MESSAGE_RETENTION_DAYS).toISOString(),
    );
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    const strict = chatMessagePurgeCutoff(now, 30);
    const generous = chatMessagePurgeCutoff(now, 3650);

    // A shorter window reaches messages written closer to today; a longer one
    // only reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("reaches everything already written at a zero-day window", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    expect(chatMessagePurgeCutoff(now, 0).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    const now = new Date("2026-10-31T00:00:00.000Z");

    expect(chatMessagePurgeCutoff(now, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase messages whose
    // retention had not run out.
    expect(() => chatMessagePurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => chatMessagePurgeCutoff(new Date(), Number.NaN)).toThrow(
      RangeError,
    );
  });
});

/**
 * The chat and the news comments are kept for the same span, deliberately.
 *
 * Both are service-tier records of what one person wrote to the others who live
 * here, and two different windows would be two answers to one question nobody
 * asked. Asserted rather than left as a coincidence two files could drift out
 * of.
 */
describe("the window itself", () => {
  it("is a year", () => {
    expect(CHAT_MESSAGE_RETENTION_DAYS).toBe(365);
  });
});

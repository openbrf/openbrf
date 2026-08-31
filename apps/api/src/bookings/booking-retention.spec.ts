import { describe, expect, it } from "vitest";

import {
  BOOKING_RETENTION_DAYS,
  bookingPurgeCutoff,
  computeBookingPurgeDate,
} from "./booking-retention";

const ENDED = new Date("2026-08-01T12:00:00.000Z");

describe("computeBookingPurgeDate", () => {
  it("anchors on the end of the booked period plus the retention window", () => {
    expect(computeBookingPurgeDate(ENDED, 365).toISOString()).toBe(
      "2027-08-01T12:00:00.000Z",
    );
  });

  it("defaults to the module's retention window", () => {
    expect(computeBookingPurgeDate(ENDED).toISOString()).toBe(
      computeBookingPurgeDate(ENDED, BOOKING_RETENTION_DAYS).toISOString(),
    );
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration, no recomputation
    // job, and the access report states the date that will actually apply.
    expect(computeBookingPurgeDate(ENDED, 30).toISOString()).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });

  it("erases as soon as the period ends at a zero-day window", () => {
    expect(computeBookingPurgeDate(ENDED, 0).toISOString()).toBe(
      ENDED.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date
    // early is an erasure before the date the report stated.
    const octoberEnd = new Date("2026-10-01T00:00:00.000Z");

    expect(computeBookingPurgeDate(octoberEnd, 30).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeBookingPurgeDate(ENDED, -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => computeBookingPurgeDate(ENDED, Number.NaN)).toThrow(
      RangeError,
    );
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per booking and hands it to the person the
 * booking is about. The job compares every booking's end against one cutoff. If
 * the two ever disagree the product erases on a day other than the one it
 * stated, so the agreement is asserted here rather than assumed from the
 * arithmetic looking symmetrical.
 */
describe("bookingPurgeCutoff", () => {
  it("is the end time whose purge date is exactly now", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    const cutoff = bookingPurgeCutoff(now, 365);

    expect(computeBookingPurgeDate(cutoff, 365).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");
    const cutoff = bookingPurgeCutoff(now, 365);

    const dueYesterday = new Date("2026-07-31T12:00:00.000Z");
    const dueTomorrow = new Date("2026-08-02T12:00:00.000Z");

    // Erasable exactly when the date the report stated has arrived.
    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      computeBookingPurgeDate(dueYesterday, 365).getTime() <= now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      computeBookingPurgeDate(dueTomorrow, 365).getTime() <= now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2027-08-01T12:00:00.000Z");

    expect(bookingPurgeCutoff(now).toISOString()).toBe(
      bookingPurgeCutoff(now, BOOKING_RETENTION_DAYS).toISOString(),
    );
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    const strict = bookingPurgeCutoff(now, 30);
    const generous = bookingPurgeCutoff(now, 3650);

    // A shorter window reaches bookings that ended closer to today; a longer
    // one only reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("reaches everything already ended at a zero-day window", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");

    expect(bookingPurgeCutoff(now, 0).toISOString()).toBe(now.toISOString());
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    const now = new Date("2026-10-31T00:00:00.000Z");

    expect(bookingPurgeCutoff(now, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase bookings whose
    // retention had not run out.
    expect(() => bookingPurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => bookingPurgeCutoff(new Date(), Number.NaN)).toThrow(
      RangeError,
    );
  });
});

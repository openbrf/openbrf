import { describe, expect, it } from "vitest";

import { dateColumnOf, localDayOf } from "../bookings/stockholm-calendar";
import {
  EVENT_SIGNUP_RETENTION_DAYS,
  computeEventSignupPurgeDate,
  eventSignupPurgeCutoff,
} from "./event-signup-retention";

/** A cleaning day that ran from ten to two on the 18th of April. */
const OCCURRENCE_ENDED = new Date("2027-04-18T12:00:00.000Z");

describe("computeEventSignupPurgeDate", () => {
  it("anchors on the end of the date signed up to plus the retention window", () => {
    expect(
      computeEventSignupPurgeDate(OCCURRENCE_ENDED, 365).toISOString(),
    ).toBe("2028-04-17T12:00:00.000Z");
  });

  it("defaults to the module's retention window", () => {
    expect(computeEventSignupPurgeDate(OCCURRENCE_ENDED).toISOString()).toBe(
      computeEventSignupPurgeDate(
        OCCURRENCE_ENDED,
        EVENT_SIGNUP_RETENTION_DAYS,
      ).toISOString(),
    );
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration, no recomputation job,
    // and the access report states the date that will actually apply.
    expect(
      computeEventSignupPurgeDate(OCCURRENCE_ENDED, 30).toISOString(),
    ).toBe("2027-05-18T12:00:00.000Z");
  });

  it("erases as soon as the date ends at a zero-day window", () => {
    expect(computeEventSignupPurgeDate(OCCURRENCE_ENDED, 0).toISOString()).toBe(
      OCCURRENCE_ENDED.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date an
    // hour early is still an erasure before the date the report stated.
    const octoberEnd = new Date("2026-10-01T00:00:00.000Z");

    expect(computeEventSignupPurgeDate(octoberEnd, 30).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeEventSignupPurgeDate(OCCURRENCE_ENDED, -1)).toThrow(
      RangeError,
    );
  });

  it("refuses a window that is not a number of days", () => {
    expect(() =>
      computeEventSignupPurgeDate(OCCURRENCE_ENDED, Number.NaN),
    ).toThrow(RangeError);
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per sign-up and hands it to the person the
 * sign-up is about. The job compares every sign-up's occurrence end against one
 * cutoff. If the two ever disagree the product erases on a day other than the one
 * it stated, so the agreement is asserted here rather than assumed from the
 * arithmetic looking symmetrical.
 */
describe("eventSignupPurgeCutoff", () => {
  it("is the occurrence end whose purge date is exactly now", () => {
    const now = new Date("2028-04-17T12:00:00.000Z");

    const cutoff = eventSignupPurgeCutoff(now, 365);

    expect(computeEventSignupPurgeDate(cutoff, 365).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2028-04-17T12:00:00.000Z");
    const cutoff = eventSignupPurgeCutoff(now, 365);

    const dueYesterday = new Date("2027-04-17T12:00:00.000Z");
    const dueTomorrow = new Date("2027-04-19T12:00:00.000Z");

    // Erasable exactly when the date the report stated has arrived.
    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      computeEventSignupPurgeDate(dueYesterday, 365).getTime() <= now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      computeEventSignupPurgeDate(dueTomorrow, 365).getTime() <= now.getTime(),
    ).toBe(false);
  });

  it("reaches an occurrence that ended exactly on the cutoff and not one a second later", () => {
    /*
     * The boundary the eligibility query is written against. The comparison in
     * the purge is `endsAt <= cutoff`, so the occurrence that ended on the
     * cutoff instant is inside the window and the one a millisecond later is
     * not - which is the same line the report's own date states from the other
     * end. An off-by-one here erases a day early or keeps a day too long, and
     * neither shows up in a count.
     */
    const now = new Date("2028-04-17T12:00:00.000Z");
    const cutoff = eventSignupPurgeCutoff(now, 365);
    const aMillisecondLater = new Date(cutoff.getTime() + 1);

    /*
     * The inside half, asserted through the other function rather than by
     * comparing the cutoff with itself: an occurrence that ended on the cutoff
     * instant states a purge date of exactly now, so a drift of a millisecond in
     * either function moves this off the boundary and fails. Comparing the
     * cutoff with itself is true of every Date and would go on passing through
     * any arithmetic at all.
     */
    expect(
      computeEventSignupPurgeDate(cutoff, 365).getTime() === now.getTime(),
    ).toBe(true);
    expect(aMillisecondLater.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      computeEventSignupPurgeDate(aMillisecondLater, 365).getTime() >
        now.getTime(),
    ).toBe(true);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2028-04-17T12:00:00.000Z");

    expect(eventSignupPurgeCutoff(now).toISOString()).toBe(
      eventSignupPurgeCutoff(now, EVENT_SIGNUP_RETENTION_DAYS).toISOString(),
    );
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2028-01-01T00:00:00.000Z");

    const strict = eventSignupPurgeCutoff(now, 30);
    const generous = eventSignupPurgeCutoff(now, 3650);

    // A shorter window reaches dates that ended closer to today; a longer one
    // only reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("reaches everything already ended at a zero-day window", () => {
    const now = new Date("2028-01-01T00:00:00.000Z");

    expect(eventSignupPurgeCutoff(now, 0).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    const now = new Date("2026-10-31T00:00:00.000Z");

    expect(eventSignupPurgeCutoff(now, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase sign-ups whose
    // retention had not run out - including ones for dates that have not
    // happened yet.
    expect(() => eventSignupPurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => eventSignupPurgeCutoff(new Date(), Number.NaN)).toThrow(
      RangeError,
    );
  });
});

/**
 * The clock this window runs on is an instant, and never a date column.
 *
 * This codebase's recurring bug is a `@db.Date` column read back as midnight UTC
 * and compared against an instant anchored to local midnight, and the two are
 * hours apart. An occurrence carries instants for exactly this reason, so the
 * window arithmetic above is instant arithmetic throughout - but the series it
 * belongs to carries `firstOn` as a date column, and a future reader reaching for
 * that as the anchor is the mistake this states in a form that fails.
 */
describe("the anchor is the occurrence's own end", () => {
  it("is hours away from what the series' date column would give", () => {
    /*
     * A cleaning day on the 18th of April, ending at two in the afternoon in
     * Stockholm. The date column for the 18th reads back as midnight UTC, which
     * is two in the morning in Stockholm on a summer date - so anchoring on it
     * would put the purge date, and with it the retention window's own boundary,
     * twelve hours from the moment the event actually ended.
     */
    const endsAt = new Date("2027-04-18T12:00:00.000Z");
    const asDateColumn = dateColumnOf(localDayOf(endsAt));

    expect(asDateColumn.toISOString()).toBe("2027-04-18T00:00:00.000Z");
    expect(
      computeEventSignupPurgeDate(endsAt, 365).getTime() -
        computeEventSignupPurgeDate(asDateColumn, 365).getTime(),
    ).toBe(12 * 60 * 60 * 1000);
  });
});

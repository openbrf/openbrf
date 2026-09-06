import { describe, expect, it } from "vitest";

import {
  computeSubletPurgeDate,
  SUBLET_RETENTION_DAYS,
  subletPurgeCutoffs,
} from "./sublet-retention";

/** A `@db.Date` column is read back as midnight UTC, which is what these are. */
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const CLOSED = new Date("2027-04-15T12:00:00.000Z");

describe("computeSubletPurgeDate", () => {
  it("anchors on the closing date where the period ended first", () => {
    // A letting that was over before the board answered - a refusal that came
    // late, or a request withdrawn after the dates had passed.
    expect(
      computeSubletPurgeDate(CLOSED, day("2027-01-31"), 730)?.toISOString(),
    ).toBe("2029-04-14T12:00:00.000Z");
  });

  it("anchors on the end of the period where that comes last", () => {
    /*
     * The load-bearing case of this file, and the reason there are two anchors
     * at all. A consent given in April 2027 for a letting running to the end of
     * 2029 must not be erased in April 2029 while the tenant is still in the
     * flat: a board asked whether it ever agreed to that letting would find
     * nothing.
     *
     * The anchor is the day after the last day, because that is when the letting
     * is over - the column carries no time, so counting from midnight of the
     * last day would erase a day early.
     */
    expect(
      computeSubletPurgeDate(CLOSED, day("2029-12-31"), 730)?.toISOString(),
    ).toBe("2032-01-01T00:00:00.000Z");
  });

  it("states no date for an application still with the board", () => {
    /*
     * An open application has no closing date to count from, and the association
     * is still processing it, so no purge date exists - and a function that
     * answered "the period plus the window" here would put an erasure date on a
     * member's access report for a request nobody has answered, and the purge
     * would then be entitled to erase it.
     */
    expect(computeSubletPurgeDate(null, day("2027-12-31"), 730)).toBeNull();
  });

  it("defaults to the module's retention window", () => {
    expect(
      computeSubletPurgeDate(CLOSED, day("2027-06-30"))?.toISOString(),
    ).toBe(
      computeSubletPurgeDate(
        CLOSED,
        day("2027-06-30"),
        SUBLET_RETENTION_DAYS,
      )?.toISOString(),
    );
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration and no recomputation
    // job, and the access report states the date that will actually apply.
    expect(
      computeSubletPurgeDate(CLOSED, day("2027-01-31"), 30)?.toISOString(),
    ).toBe("2027-05-15T12:00:00.000Z");
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date a
    // day early is an erasure before the date the report stated.
    expect(
      computeSubletPurgeDate(
        new Date("2027-10-01T00:00:00.000Z"),
        day("2027-01-31"),
        30,
      )?.toISOString(),
    ).toBe("2027-10-31T00:00:00.000Z");
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeSubletPurgeDate(CLOSED, day("2027-06-30"), -1)).toThrow(
      RangeError,
    );
  });

  it("refuses a window that is not a number of days", () => {
    expect(() =>
      computeSubletPurgeDate(CLOSED, day("2027-06-30"), Number.NaN),
    ).toThrow(RangeError);
  });

  it("refuses a bad window even for an open application", () => {
    // The null branch must not be a way past the guard: a caller passing a
    // nonsense window would otherwise be told nothing is wrong.
    expect(() => computeSubletPurgeDate(null, day("2027-06-30"), -1)).toThrow(
      RangeError,
    );
  });
});

/**
 * The cutoffs and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per application and hands it to the person
 * the application is about. The job compares every row against two cutoffs, on
 * the identity `max(a, b) + w <= now` being exactly `a + w <= now and b + w <=
 * now`. If the two ever disagree the product erases on a day other than the one
 * it stated, so the agreement is asserted here rather than assumed from the
 * arithmetic looking symmetrical.
 */
describe("subletPurgeCutoffs", () => {
  const now = new Date("2029-04-14T12:00:00.000Z");

  /** Whether the scan's two comparisons would select this row. */
  const scanned = (
    closedAt: Date | null,
    periodTo: Date,
    retentionDays: number,
  ): boolean => {
    const cutoffs = subletPurgeCutoffs(now, retentionDays);
    return (
      closedAt !== null &&
      closedAt.getTime() <= cutoffs.closedAtOrBefore.getTime() &&
      periodTo.getTime() <= cutoffs.periodEndedOnOrBefore.getTime()
    );
  };

  /** Whether the date the report stated has arrived. */
  const stated = (
    closedAt: Date | null,
    periodTo: Date,
    retentionDays: number,
  ): boolean => {
    const due = computeSubletPurgeDate(closedAt, periodTo, retentionDays);
    return due !== null && due.getTime() <= now.getTime();
  };

  it("selects exactly what the stated purge date says is due", () => {
    /*
     * Every combination that matters, both anchors driven independently: one
     * side past the window and the other not, both past, neither past, and the
     * boundary day itself on each anchor. A scan that agreed with the report on
     * the ordinary cases and not on a boundary would erase a day early exactly
     * once per row, which is the failure a rounded comparison produces.
     */
    const closings = [
      null,
      new Date("2027-04-14T12:00:00.000Z"),
      new Date("2027-04-14T12:00:00.001Z"),
      new Date("2027-04-15T12:00:00.000Z"),
      new Date("2029-04-14T12:00:00.000Z"),
    ];
    const periods = [
      day("2027-04-12"),
      day("2027-04-13"),
      day("2027-04-14"),
      day("2027-04-15"),
      day("2029-04-13"),
      day("2032-01-01"),
    ];

    for (const closedAt of closings) {
      for (const periodTo of periods) {
        expect(
          scanned(closedAt, periodTo, 730),
          `closedAt ${String(closedAt?.toISOString())} periodTo ${periodTo.toISOString()}`,
        ).toBe(stated(closedAt, periodTo, 730));
      }
    }
  });

  it("counts the window from the end of the period and not from its last day", () => {
    /*
     * The rounding this pair is most likely to get wrong, and it is worth a day
     * of somebody's record. A letting is over at midnight *after* its last day,
     * so a period ending on the 15th of April 2027 is still one day short of
     * erasable two years and a day later - while one ending on the 14th is
     * exactly due. A cutoff that counted from midnight *of* the last day would
     * take both, erasing one of them a day before the date the access report
     * stated.
     */
    const cutoffs = subletPurgeCutoffs(now, 730);

    expect(
      day("2027-04-15").getTime() <= cutoffs.periodEndedOnOrBefore.getTime(),
    ).toBe(false);
    expect(
      day("2027-04-14").getTime() <= cutoffs.periodEndedOnOrBefore.getTime(),
    ).toBe(true);
  });

  it("states the period cutoff as a whole day", () => {
    // The column being compared is always midnight UTC of some date, so a cutoff
    // carrying a time of day would leave the comparison depending on how the
    // client renders a timestamp against a date column. Flooring changes no
    // answer, because a whole day is at or before an instant exactly when it is
    // at or before the day that instant falls in.
    const cutoffs = subletPurgeCutoffs(now, 730);

    expect(cutoffs.periodEndedOnOrBefore.toISOString()).toBe(
      "2027-04-14T00:00:00.000Z",
    );
  });

  it("defaults to the module's retention window", () => {
    expect(subletPurgeCutoffs(now).closedAtOrBefore.toISOString()).toBe(
      subletPurgeCutoffs(
        now,
        SUBLET_RETENTION_DAYS,
      ).closedAtOrBefore.toISOString(),
    );
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const strict = subletPurgeCutoffs(now, 30);
    const generous = subletPurgeCutoffs(now, 3650);

    // A shorter window reaches applications closed closer to today; a longer one
    // only reaches older ones.
    expect(strict.closedAtOrBefore.getTime()).toBeGreaterThan(
      generous.closedAtOrBefore.getTime(),
    );
    expect(strict.periodEndedOnOrBefore.getTime()).toBeGreaterThan(
      generous.periodEndedOnOrBefore.getTime(),
    );
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase applications
    // whose retention had not run out.
    expect(() => subletPurgeCutoffs(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => subletPurgeCutoffs(new Date(), Number.NaN)).toThrow(
      RangeError,
    );
  });
});

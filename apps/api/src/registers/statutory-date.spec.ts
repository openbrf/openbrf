import { describe, expect, it } from "vitest";

import { statutoryDate } from "./statutory-date";

/**
 * The date a statutory register row is stamped with, on the days the answer is
 * not obvious.
 *
 * The boundary tests are the reason this file exists. This repository's
 * recurring defect is a `@db.Date` column compared against a locally anchored
 * instant, found twice at opposite ends of one predicate in the booking module,
 * and it is invisible to any test written at midday: Stockholm and UTC agree on
 * the date for twenty-two hours out of twenty-four. The cases below are inside
 * the two that disagree, at both offsets and across both daylight saving
 * transitions.
 */

/** The value a `@db.Date` column holds, as an ISO calendar date. */
const stored = (column: Date): string => column.toISOString().slice(0, 10);

describe("statutoryDate", () => {
  it("writes the date the board stated, as midnight UTC", () => {
    const parsed = statutoryDate(
      "2027-03-01",
      new Date("2027-06-01T12:00:00Z"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Midnight UTC and not local midnight: a date column carries no zone, and
    // 2027-02-28T23:00:00Z is what a locally anchored instant would have
    // written - the previous day, in a two-week statutory window.
    expect(parsed.column.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(parsed.day).toEqual({ year: 2027, month: 3, day: 1 });
  });

  it("accepts today when local midnight has passed but the UTC date has not", () => {
    // 00:30 in Stockholm on the 2nd of July, which is 22:30 UTC on the 1st.
    // A board recording that morning's termination gets it accepted; a
    // comparison against the instant's UTC date would call the 2nd of July a
    // future date and refuse the only correct answer.
    const parsed = statutoryDate(
      "2027-07-02",
      new Date("2027-07-01T22:30:00Z"),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(stored(parsed.column)).toBe("2027-07-02");
    }
  });

  it("accepts today in winter, when the offset is one hour rather than two", () => {
    // 00:30 in Stockholm on the 2nd of January is 23:30 UTC on the 1st. The
    // offset is different and the conclusion is the same, which is what says
    // nothing here carries a hard-coded offset.
    const parsed = statutoryDate(
      "2027-01-02",
      new Date("2027-01-01T23:30:00Z"),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(stored(parsed.column)).toBe("2027-01-02");
    }
  });

  it("refuses tomorrow from the same small hours, rather than accepting a day either side", () => {
    // The mirror of the case above, and the reason it is not enough to widen
    // the comparison by a day: at 00:30 on the 2nd of July, the 3rd is still
    // in the future.
    const parsed = statutoryDate(
      "2027-07-03",
      new Date("2027-07-01T22:30:00Z"),
    );

    expect(parsed).toEqual({ ok: false, problem: "date-in-the-future" });
  });

  it("refuses tomorrow from the last hour of the UTC day", () => {
    // 23:30 UTC on the 1st of July is already the 2nd in Stockholm, so the
    // 2nd is today and the 3rd is not.
    expect(
      statutoryDate("2027-07-03", new Date("2027-07-01T23:30:00Z")),
    ).toEqual({
      ok: false,
      problem: "date-in-the-future",
    });
  });

  it("accepts a date on the spring transition day, when 02:00 does not exist", () => {
    // The last Sunday in March 2027 is the 28th. Nothing here asks for a time
    // of day, so the hour the clocks skip has no bearing on the answer - which
    // is the property to hold rather than to assume.
    const parsed = statutoryDate(
      "2027-03-28",
      new Date("2027-03-28T05:00:00Z"),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(stored(parsed.column)).toBe("2027-03-28");
    }
  });

  it("accepts a date on the autumn transition day, when 02:00 happens twice", () => {
    // The last Sunday in October 2027 is the 31st, a 25-hour day. Both times
    // the clock reads 02:30 are on the 31st, so it is today either way.
    const parsed = statutoryDate(
      "2027-10-31",
      new Date("2027-10-31T00:30:00Z"),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(stored(parsed.column)).toBe("2027-10-31");
    }
  });

  it("accepts a date well in the past, which is what a late report is", () => {
    // Lag (2026:484) 3 kap. 10 § lets Lantmateriet order a late report in, so
    // an old termination has to be recordable rather than refused for age.
    const parsed = statutoryDate(
      "2019-06-01",
      new Date("2027-06-01T12:00:00Z"),
    );

    expect(parsed.ok).toBe(true);
  });

  it("refuses a day the calendar does not have", () => {
    // Date.parse would answer the 2nd of March. On a row nobody can correct,
    // silently moving a statutory date is worse than refusing the entry.
    expect(
      statutoryDate("2027-02-30", new Date("2027-06-01T12:00:00Z")),
    ).toEqual({
      ok: false,
      problem: "date-not-a-calendar-date",
    });
  });

  it("refuses a date that is not written as a calendar date at all", () => {
    for (const text of ["2027-2-01", "01/03/2027", "yesterday", ""]) {
      expect(
        statutoryDate(text, new Date("2027-06-01T12:00:00Z")),
        `${text} is not a calendar date`,
      ).toEqual({ ok: false, problem: "date-not-a-calendar-date" });
    }
  });
});

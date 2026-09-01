import { describe, expect, it } from "vitest";

import { compareByDeadline, daysUntilDue, reportState } from "./report-state";

/**
 * Where a duty stands, on the days the answer is not obvious.
 *
 * The deadline's own boundary is the whole point of this module: "inom tva
 * veckor" includes the fourteenth day, so a duty due today is due and not late,
 * and a comparison written with the wrong sign puts an association one day early
 * into the state Lag (2026:484) 3 kap. 10 § attaches a fine to. The cases below
 * are the boundary in both directions, the two daylight saving transitions - a
 * deadline compared as an instant is a day out for part of the year - and a duty
 * reported after its deadline, which stays reported.
 */

/** The value a `@db.Date` column holds, as an ISO calendar date. */
const column = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/**
 * An instant in the association's own afternoon.
 *
 * Midday rather than midnight, because midnight is the hour at which a wrong
 * zone conversion is invisible: 2027-06-15T00:00:00Z is still the 15th in
 * Stockholm, while 2027-06-15T23:00:00Z is the 16th.
 */
const afternoon = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

describe("reportState", () => {
  it("is due on the day the window closes", () => {
    // The fourteenth day is inside "inom tva veckor". A duty answered today is
    // answered in time, and calling it overdue would put the association into
    // the only state on the queue that costs money a day early.
    expect(
      reportState({
        dueOn: column("2027-06-15"),
        reportedOn: null,
        now: afternoon("2027-06-15"),
      }),
    ).toBe("due");
  });

  it("is overdue the day after", () => {
    expect(
      reportState({
        dueOn: column("2027-06-15"),
        reportedOn: null,
        now: afternoon("2027-06-16"),
      }),
    ).toBe("overdue");
  });

  it("is due while the window is still open", () => {
    expect(
      reportState({
        dueOn: column("2027-06-15"),
        reportedOn: null,
        now: afternoon("2027-06-02"),
      }),
    ).toBe("due");
  });

  it("stays reported when the anmalan was made late", () => {
    // The lateness is not lost: the day stated and the day due are both on the
    // row. Overwriting the state with overdue would leave nothing separating a
    // duty somebody dealt with late from one nobody has dealt with at all, and
    // the queue exists to show the second.
    expect(
      reportState({
        dueOn: column("2027-06-15"),
        reportedOn: column("2027-07-01"),
        now: afternoon("2027-07-02"),
      }),
    ).toBe("reported");
  });

  it("is reported before the deadline has even arrived", () => {
    expect(
      reportState({
        dueOn: column("2027-06-15"),
        reportedOn: column("2027-06-03"),
        now: afternoon("2027-06-04"),
      }),
    ).toBe("reported");
  });

  it("reads the day in the association's own zone across the spring transition", () => {
    /*
     * 2027-03-28T00:30:00Z is 02:30 in Stockholm on the 28th - the hour the
     * clocks go forward - so the calendar day is the 28th and a duty due on the
     * 28th is still due. Comparing the instant against the column, which is
     * midnight UTC on the 28th, gives the same answer here; comparing it against
     * a locally anchored midnight would not.
     */
    expect(
      reportState({
        dueOn: column("2027-03-28"),
        reportedOn: null,
        now: new Date("2027-03-28T00:30:00.000Z"),
      }),
    ).toBe("due");
  });

  it("reads the day in the association's own zone late in the evening", () => {
    // 22:30 UTC on the 30th of June is 00:30 on the 1st of July in Stockholm, so
    // a duty due on the 30th is overdue. A comparison in UTC would answer that
    // it is still due, and the association would read a passed deadline as a
    // running one for two hours every summer night.
    expect(
      reportState({
        dueOn: column("2027-06-30"),
        reportedOn: null,
        now: new Date("2027-06-30T22:30:00.000Z"),
      }),
    ).toBe("overdue");
  });
});

describe("daysUntilDue", () => {
  it("is zero on the last day of the window", () => {
    expect(daysUntilDue(column("2027-06-15"), afternoon("2027-06-15"))).toBe(0);
  });

  it("is negative once the deadline has passed", () => {
    expect(daysUntilDue(column("2027-06-15"), afternoon("2027-06-18"))).toBe(
      -3,
    );
  });

  it("counts calendar days across the autumn transition", () => {
    // Sunday the 31st of October 2027 is 25 hours long in Stockholm. From the
    // 25th to the 5th of November is eleven days whether or not one of them is
    // long, and dividing a difference in milliseconds by 86 400 000 would answer
    // ten.
    expect(daysUntilDue(column("2027-11-05"), afternoon("2027-10-25"))).toBe(
      11,
    );
  });
});

describe("compareByDeadline", () => {
  it("puts the earliest deadline first, so an overdue duty leads", () => {
    const rows = [
      { id: "b", dueOn: column("2027-06-20") },
      { id: "a", dueOn: column("2027-05-01") },
      { id: "c", dueOn: column("2027-06-01") },
    ];

    expect([...rows].sort(compareByDeadline).map((row) => row.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("breaks a tie on the identifier, so two reads agree", () => {
    // Two duties falling due on one day is the ordinary case for a building
    // where a transfer and a termination were recorded in one board meeting. An
    // unstable order there reads as a list that changed when nothing did.
    const rows = [
      { id: "second", dueOn: column("2027-06-01") },
      { id: "first", dueOn: column("2027-06-01") },
    ];

    expect([...rows].sort(compareByDeadline).map((row) => row.id)).toEqual([
      "first",
      "second",
    ]);
  });
});

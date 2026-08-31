import { describe, expect, it } from "vitest";

import {
  isWritableDeadline,
  motionDeadlineView,
  nextMotionDeadline,
  readMotionDeadline,
} from "./motion-deadline";

/**
 * The bylaws' motion deadline, resolved to a date.
 *
 * Three properties, and each of them is a way this can be wrong on the one day
 * of the year anybody looks at it.
 *
 * A deadline is inclusive: a member on the last day is inside it, and telling
 * them the deadline is next year would be wrong by a year exactly when it matters
 * most.
 *
 * The year rolls over, because a standing clause has a next occurrence rather
 * than a date. A resolver that always answered the current year would say "31
 * January 2027" all through February 2027.
 *
 * And the answer is the Stockholm calendar day, not the UTC one, because the
 * association's year is the Swedish one - so the last hours of the deadline day
 * must not resolve to the day after.
 */

/** Midday, so an accidental UTC reading does not shift the day by itself. */
const JANUARY_FIRST = new Date("2027-01-01T12:00:00.000Z");

describe("nextMotionDeadline", () => {
  it("answers this year while the date is still to come", () => {
    expect(nextMotionDeadline({ month: 1, day: 31 }, JANUARY_FIRST)).toEqual({
      year: 2027,
      month: 1,
      day: 31,
    });
  });

  it("includes the deadline day itself", () => {
    // A deadline is a day and not an instant: somebody submitting on the 31st is
    // inside a deadline of the 31st.
    const onTheDay = new Date("2027-01-31T09:00:00.000Z");

    expect(nextMotionDeadline({ month: 1, day: 31 }, onTheDay)).toEqual({
      year: 2027,
      month: 1,
      day: 31,
    });
  });

  it("rolls to next year the day after", () => {
    const dayAfter = new Date("2027-02-01T09:00:00.000Z");

    expect(nextMotionDeadline({ month: 1, day: 31 }, dayAfter)).toEqual({
      year: 2028,
      month: 1,
      day: 31,
    });
  });

  it("reads the day in Stockholm and not in UTC", () => {
    /*
     * 23:30 in Stockholm on the last day of January is 22:30 UTC the same day in
     * winter - but the hazard is the other direction, and it is the reason this
     * resolver takes the local day at all: an instant just after local midnight
     * is still the previous day in UTC. Here, half an hour past local midnight
     * on the 1st of February is 23:30 UTC on the 31st of January, so a resolver
     * reading UTC fields would answer "the deadline is today" to a member who
     * has already missed it.
     */
    const justPastLocalMidnight = new Date("2027-01-31T23:30:00.000Z");

    expect(
      nextMotionDeadline({ month: 1, day: 31 }, justPastLocalMidnight),
    ).toEqual({ year: 2028, month: 1, day: 31 });
  });

  it("clamps the 29th of February to the 28th in a year that has no 29th", () => {
    // The clause says the 29th and keeps saying it; what moves is the date it
    // resolves to in a year that does not have one.
    const inJanuary2027 = new Date("2027-01-15T12:00:00.000Z");

    expect(nextMotionDeadline({ month: 2, day: 29 }, inJanuary2027)).toEqual({
      year: 2027,
      month: 2,
      day: 28,
    });
  });

  it("keeps the 29th of February in a leap year", () => {
    const inJanuary2028 = new Date("2028-01-15T12:00:00.000Z");

    expect(nextMotionDeadline({ month: 2, day: 29 }, inJanuary2028)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  it("rolls over the end of the year without moving the month", () => {
    const inDecember = new Date("2027-12-15T12:00:00.000Z");

    expect(nextMotionDeadline({ month: 1, day: 31 }, inDecember)).toEqual({
      year: 2028,
      month: 1,
      day: 31,
    });
  });
});

describe("readMotionDeadline", () => {
  it("reads both columns as a deadline", () => {
    expect(
      readMotionDeadline({ motionDeadlineMonth: 1, motionDeadlineDay: 31 }),
    ).toEqual({ month: 1, day: 31 });
  });

  it("reads two nulls as no deadline the bylaws set", () => {
    expect(
      readMotionDeadline({
        motionDeadlineMonth: null,
        motionDeadlineDay: null,
      }),
    ).toBeNull();
  });

  it.each([
    [
      "a month without a day",
      { motionDeadlineMonth: 1, motionDeadlineDay: null },
    ],
    [
      "a day without a month",
      { motionDeadlineMonth: null, motionDeadlineDay: 31 },
    ],
  ])("reads %s as no deadline rather than half of one", (_case, row) => {
    /*
     * Half a deadline is no deadline, and the direction of that reading is the
     * point: the alternative is a screen showing a member a deadline it cannot
     * name, or intake behaving as if a rule existed that nobody can read. The
     * settings write refuses one column without the other, so this is what a row
     * written before that rule, or by hand, resolves to.
     */
    expect(readMotionDeadline(row)).toBeNull();
  });
});

describe("motionDeadlineView", () => {
  it("carries the clause as written and the date it next falls on", () => {
    expect(motionDeadlineView({ month: 2, day: 29 }, JANUARY_FIRST)).toEqual({
      month: 2,
      day: 29,
      nextOn: "2027-02-28",
    });
  });

  it("is null when the bylaws set none", () => {
    expect(motionDeadlineView(null, JANUARY_FIRST)).toBeNull();
  });
});

describe("isWritableDeadline", () => {
  it.each([
    [1, 31],
    [2, 29],
    [4, 30],
    [12, 31],
  ])("accepts %i-%i, which a clause could name", (month, day) => {
    expect(isWritableDeadline(month, day)).toBe(true);
  });

  it.each([
    ["the 31st of February, which no year has", 2, 31],
    ["the 30th of February", 2, 30],
    ["the 31st of April", 4, 31],
    ["a thirteenth month", 13, 1],
    ["a zeroth month", 0, 1],
    ["a zeroth day", 1, 0],
    ["a fractional day", 1, 1.5],
  ])("refuses %s", (_case, month, day) => {
    expect(isWritableDeadline(month, day)).toBe(false);
  });
});

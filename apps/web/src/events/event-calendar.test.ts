import { describe, expect, it } from "vitest";

import {
  formatEventDay,
  hasBegun,
  minuteOfTimeValue,
  timeValueOfMinute,
} from "./event-calendar";

/**
 * The part of the association's clock this module answers.
 *
 * Everything about which date an occurrence belongs to is the server's, and it
 * arrives already decided. What is left is reading a bare date to a person,
 * saying whether an instant has passed, and moving a time of day between the
 * minute the API takes and the value a time field holds.
 *
 * The date reading carries a year on purpose: this calendar reaches half a year
 * ahead, so it crosses a new year, and "onsdag 7 januari" is ambiguous exactly
 * when a board is planning.
 *
 * The year is also what a date must not silently gain. `Date.UTC` reads the 40th
 * of a month as the month after, so text that is not a real date has to come
 * back unchanged rather than as a different real date the board never entered.
 */

describe("a date as a person reads it", () => {
  it("names the weekday, the date and the year", () => {
    expect(formatEventDay("2026-04-18", "sv")).toBe("lördag 18 april 2026");
    expect(formatEventDay("2027-01-07", "sv")).toBe("torsdag 7 januari 2027");
  });

  it("reads the date it was given and never the one before it", () => {
    // A bare date is not an instant. Read as one in the association's zone it
    // would fall on the previous day for part of the year, so the whole of this
    // module formats it as noon UTC and tells the formatter UTC.
    expect(formatEventDay("2026-01-01", "en")).toContain("January 1, 2026");
    expect(formatEventDay("2026-12-31", "en")).toContain("December 31, 2026");
  });

  it("answers text that is not a date with the text itself", () => {
    // "2026-13-40" would otherwise come back as a day in February 2027, which
    // is a date nobody entered rendered as though somebody had.
    expect(formatEventDay("2026-13-40", "sv")).toBe("2026-13-40");
    expect(formatEventDay("2026-02-30", "sv")).toBe("2026-02-30");
    expect(formatEventDay("den 18 april", "sv")).toBe("den 18 april");
    expect(formatEventDay("", "sv")).toBe("");
  });
});

describe("whether an instant has passed", () => {
  const now = new Date("2026-04-18T08:00:00.000Z");

  it("compares instants and reads no calendar at all", () => {
    expect(hasBegun("2026-04-18T07:59:59.000Z", now)).toBe(true);
    expect(hasBegun("2026-04-18T08:00:00.000Z", now)).toBe(true);
    expect(hasBegun("2026-04-18T08:00:01.000Z", now)).toBe(false);
  });

  it("says an unreadable instant has not begun", () => {
    // The alternative would put "has begun" on a row the server would happily
    // take a sign-up for, and the reader would have no control to press.
    expect(hasBegun("not an instant", now)).toBe(false);
    expect(hasBegun("", now)).toBe(false);
  });
});

describe("a time of day between the wire and a time field", () => {
  it("reads a time field as minutes past local midnight", () => {
    expect(minuteOfTimeValue("00:00")).toBe(0);
    expect(minuteOfTimeValue("10:00")).toBe(600);
    expect(minuteOfTimeValue(" 18:59 ")).toBe(1139);
  });

  it("reads nothing from a field that holds no time", () => {
    expect(minuteOfTimeValue("")).toBeNull();
    expect(minuteOfTimeValue("10")).toBeNull();
    expect(minuteOfTimeValue("kl 10")).toBeNull();
    // Past the end of a day, which is not a time of day the API takes: minute
    // 1440 is the following midnight and the series would start a day late.
    expect(minuteOfTimeValue("24:00")).toBeNull();
    expect(minuteOfTimeValue("10:99")).toBeNull();
  });

  it("writes a minute back as the value a time field holds", () => {
    expect(timeValueOfMinute(0)).toBe("00:00");
    expect(timeValueOfMinute(600)).toBe("10:00");
    expect(timeValueOfMinute(1139)).toBe("18:59");
  });

  it("round-trips every minute of the day", () => {
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      expect(minuteOfTimeValue(timeValueOfMinute(minute))).toBe(minute);
    }
  });
});

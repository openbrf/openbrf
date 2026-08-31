import { describe, expect, it } from "vitest";

import {
  compareLocalDays,
  formatBookingDate,
  formatDayWithWeekday,
  formatTimeOfDay,
  localDayNow,
  shiftLocalDay,
  windowDaysFor,
} from "./booking-calendar";

/**
 * Reading the association's clock in the browser.
 *
 * Two properties are worth pinning here, because both fail silently and both
 * fail on the days a booking screen matters most.
 *
 * A time of day has to come from the platform's time-zone database rather than
 * from an offset: a laundry room opens at seven in September and at seven in
 * December, and the instants those two name are an hour apart. Anything that
 * added a fixed number of hours would be right for half the year.
 *
 * A calendar date has to shift by calendar days and not by 24 hours: the day
 * after the 25th of October 2026 is the 26th, although that Sunday is 25 hours
 * long.
 */

describe("the time of day a slot opens at", () => {
  it("is the association's own, on both sides of the summer-time change", () => {
    // Two different instants that are both seven in the morning in Stockholm:
    // 05:00 UTC in September and 06:00 UTC in December.
    expect(formatTimeOfDay("2026-09-16T05:00:00.000Z", "sv")).toBe("07:00");
    expect(formatTimeOfDay("2026-12-16T06:00:00.000Z", "sv")).toBe("07:00");
  });

  it("answers with the value it was given when that is not an instant", () => {
    expect(formatTimeOfDay("not-a-date", "sv")).toBe("not-a-date");
  });
});

describe("the calendar date now", () => {
  it("is the building's day and not the viewer's", () => {
    // Half past eleven at night in Stockholm is still the 31st, and half an
    // hour later is the 1st. A date taken from the instant's own UTC fields
    // would answer the 31st for both.
    expect(localDayNow(new Date("2026-08-31T21:30:00.000Z"))).toBe(
      "2026-08-31",
    );
    expect(localDayNow(new Date("2026-08-31T22:30:00.000Z"))).toBe(
      "2026-09-01",
    );
  });
});

describe("shifting a calendar date", () => {
  it("crosses both summer-time changes by one day", () => {
    // The 25-hour Sunday in October and the 23-hour Sunday in March. Adding
    // milliseconds through a zone would land on the day before or after.
    expect(shiftLocalDay("2026-10-25", 1)).toBe("2026-10-26");
    expect(shiftLocalDay("2026-03-29", 1)).toBe("2026-03-30");
  });

  it("crosses months, years and a leap day", () => {
    expect(shiftLocalDay("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftLocalDay("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftLocalDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftLocalDay("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("shifts a whole window at a time", () => {
    expect(shiftLocalDay("2026-09-14", 7)).toBe("2026-09-21");
    expect(shiftLocalDay("2026-09-14", -7)).toBe("2026-09-07");
  });

  it("leaves text that is not a date alone", () => {
    // So a malformed value from a response cannot become a different real date
    // on its way into a request.
    expect(shiftLocalDay("", 1)).toBe("");
    expect(shiftLocalDay("2026-13-40", 1)).toBe("2026-13-40");
  });
});

describe("comparing calendar dates", () => {
  it("orders them by the calendar", () => {
    expect(compareLocalDays("2026-09-14", "2026-09-21")).toBeLessThan(0);
    expect(compareLocalDays("2026-09-21", "2026-09-14")).toBeGreaterThan(0);
    expect(compareLocalDays("2026-09-14", "2026-09-14")).toBe(0);
  });
});

describe("how a date reads", () => {
  it("carries the weekday, because that is how a laundry hour is chosen", () => {
    expect(formatDayWithWeekday("2026-09-16", "sv")).toBe(
      "onsdag 16 september",
    );
  });

  it("carries the year where a booking stands on its own", () => {
    expect(formatBookingDate("2026-09-16T05:00:00.000Z", "sv")).toBe(
      "16 september 2026",
    );
  });

  it("names the day the association is in, not the day UTC is in", () => {
    // Half past midnight on the 17th in Stockholm, which is still half past ten
    // at night on the 16th in UTC. A date read off the instant's own UTC fields
    // would answer the 16th.
    expect(formatBookingDate("2026-09-16T22:30:00.000Z", "sv")).toBe(
      "17 september 2026",
    );
  });
});

describe("how many days a calendar shows", () => {
  it("is a week of a laundry room and four weeks of anything by the day", () => {
    expect(windowDaysFor("TIME_SLOTS")).toBe(7);
    expect(windowDaysFor("WHOLE_DAY")).toBe(28);
    expect(windowDaysFor("DATE_RANGE")).toBe(28);
  });
});

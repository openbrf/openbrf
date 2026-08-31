import { describe, expect, it } from "vitest";

import {
  addLocalDays,
  compareLocalDays,
  dateColumnOf,
  formatLocalDay,
  instantAt,
  type LocalDay,
  localDayOf,
  localDaysBetween,
  localMinuteOf,
  localWeekAround,
  parseLocalDay,
} from "./stockholm-calendar";

/**
 * The wall clock, against the two Sundays a year that make it interesting.
 *
 * In 2027 the clocks go forward on the 28th of March, from 02:00 to 03:00, and
 * back on the 31st of October, from 03:00 to 02:00. Those are the dates every
 * assertion below is anchored on, written out rather than computed, so a test
 * that started passing because the arithmetic changed cannot also have changed
 * what it is testing against.
 */
const MARCH_SUNDAY: LocalDay = { year: 2027, month: 3, day: 28 };
const MARCH_SATURDAY: LocalDay = { year: 2027, month: 3, day: 27 };
const MARCH_MONDAY: LocalDay = { year: 2027, month: 3, day: 29 };
const OCTOBER_SUNDAY: LocalDay = { year: 2027, month: 10, day: 31 };
const OCTOBER_SATURDAY: LocalDay = { year: 2027, month: 10, day: 30 };

const SEVEN_IN_THE_MORNING = 7 * 60;

/** The instant as it prints, or the words "no such time", for a message. */
function iso(instant: Date | null): string {
  return instant === null ? "none" : instant.toISOString();
}

describe("a local time of day", () => {
  it("names the instant an hour behind UTC in winter", () => {
    expect(iso(instantAt({ year: 2027, month: 1, day: 15 }, 12 * 60))).toBe(
      "2027-01-15T11:00:00.000Z",
    );
  });

  it("names the instant two hours behind UTC in summer", () => {
    // The same wall-clock noon, a different instant. Anything that stored a
    // time of day as an instant would have one of these two wrong.
    expect(iso(instantAt({ year: 2027, month: 7, day: 15 }, 12 * 60))).toBe(
      "2027-07-15T10:00:00.000Z",
    );
  });

  it("rolls a minute past midnight into the following day", () => {
    // 1440 is the closing bound a resource open until midnight carries, and it
    // has to mean the next midnight rather than an hour that does not exist.
    expect(iso(instantAt({ year: 2027, month: 1, day: 15 }, 24 * 60))).toBe(
      iso(instantAt({ year: 2027, month: 1, day: 16 }, 0)),
    );
  });
});

describe("the Sunday the clocks go forward", () => {
  it("has no half past two", () => {
    // The hour is skipped, so there is no instant to answer with. Anything
    // that answered 03:30 would put a booking an hour from where it was asked
    // for, and the two would disagree about which slot it was.
    expect(instantAt(MARCH_SUNDAY, 2 * 60 + 30)).toBeNull();
  });

  it.each([
    ["one o'clock", 60, "2027-03-28T00:00:00.000Z"],
    ["three o'clock", 3 * 60, "2027-03-28T01:00:00.000Z"],
  ])("still has %s", (_when, minute, expected) => {
    expect(iso(instantAt(MARCH_SUNDAY, minute))).toBe(expected);
  });

  it("still opens the laundry room at seven", () => {
    /*
     * The property the whole module exists for. Seven o'clock on the Saturday
     * and seven o'clock on the Sunday are an hour apart as instants, because
     * the clocks moved between them, and both are seven o'clock.
     */
    expect(iso(instantAt(MARCH_SATURDAY, SEVEN_IN_THE_MORNING))).toBe(
      "2027-03-27T06:00:00.000Z",
    );
    expect(iso(instantAt(MARCH_SUNDAY, SEVEN_IN_THE_MORNING))).toBe(
      "2027-03-28T05:00:00.000Z",
    );
    expect(iso(instantAt(MARCH_MONDAY, SEVEN_IN_THE_MORNING))).toBe(
      "2027-03-29T05:00:00.000Z",
    );
  });

  it("is 23 hours long", () => {
    const opens = instantAt(MARCH_SUNDAY, 0);
    const closes = instantAt(MARCH_MONDAY, 0);
    expect((Number(closes) - Number(opens)) / (60 * 60 * 1000)).toBe(23);
  });
});

describe("the Sunday the clocks go back", () => {
  it("answers the first of the two half past twos", () => {
    /*
     * 00:30 UTC is 02:30 on the summer clock and 01:30 UTC is 02:30 on the
     * winter one, so both are half past two that day. The earlier is the
     * answer: two rows a screen could not tell apart is worse than an hour
     * belonging to the slot that was already running.
     */
    expect(iso(instantAt(OCTOBER_SUNDAY, 2 * 60 + 30))).toBe(
      "2027-10-31T00:30:00.000Z",
    );
  });

  it("still opens the laundry room at seven", () => {
    expect(iso(instantAt(OCTOBER_SATURDAY, SEVEN_IN_THE_MORNING))).toBe(
      "2027-10-30T05:00:00.000Z",
    );
    expect(iso(instantAt(OCTOBER_SUNDAY, SEVEN_IN_THE_MORNING))).toBe(
      "2027-10-31T06:00:00.000Z",
    );
  });

  it("is 25 hours long", () => {
    const opens = instantAt(OCTOBER_SUNDAY, 0);
    const closes = instantAt({ year: 2027, month: 11, day: 1 }, 0);
    expect((Number(closes) - Number(opens)) / (60 * 60 * 1000)).toBe(25);
  });
});

describe("reading an instant back", () => {
  it("dates it by the association's clock and not by UTC", () => {
    // Half past midnight local on the first of January is still the previous
    // year in UTC. A calendar dated the UTC way would file it under the wrong
    // day, and the whole week under the wrong week.
    const instant = new Date("2026-12-31T23:30:00.000Z");
    expect(formatLocalDay(localDayOf(instant))).toBe("2027-01-01");
    expect(localMinuteOf(instant)).toBe(30);
  });

  it("reads the summer offset off a summer instant", () => {
    expect(localMinuteOf(new Date("2027-07-15T10:00:00.000Z"))).toBe(12 * 60);
  });
});

describe("calendar arithmetic", () => {
  it("crosses a month, a year and a leap day", () => {
    expect(
      formatLocalDay(addLocalDays({ year: 2027, month: 1, day: 31 }, 1)),
    ).toBe("2027-02-01");
    expect(
      formatLocalDay(addLocalDays({ year: 2027, month: 12, day: 31 }, 1)),
    ).toBe("2028-01-01");
    expect(
      formatLocalDay(addLocalDays({ year: 2028, month: 2, day: 28 }, 1)),
    ).toBe("2028-02-29");
  });

  it("counts days across a clock change as whole days", () => {
    // 23 and 25 hours are both one day. Anything dividing milliseconds by 24
    // hours would answer 0 or 1 depending on the direction and round the wrong
    // way on one of the two Sundays.
    expect(localDaysBetween(MARCH_SATURDAY, MARCH_MONDAY)).toBe(2);
    expect(
      localDaysBetween(OCTOBER_SATURDAY, { year: 2027, month: 11, day: 1 }),
    ).toBe(2);
  });

  it("orders dates", () => {
    expect(compareLocalDays(MARCH_SATURDAY, MARCH_SUNDAY)).toBeLessThan(0);
    expect(compareLocalDays(MARCH_SUNDAY, MARCH_SUNDAY)).toBe(0);
    expect(compareLocalDays(MARCH_MONDAY, MARCH_SUNDAY)).toBeGreaterThan(0);
  });
});

describe("a date column", () => {
  it("holds midnight UTC and not the local midnight of the same date", () => {
    const summerDay: LocalDay = { year: 2027, month: 7, day: 1 };

    expect(dateColumnOf(summerDay).toISOString()).toBe(
      "2027-07-01T00:00:00.000Z",
    );
    /*
     * Two hours apart in summer, and the reason a residency date and a booked
     * period cannot be compared as instants: local midnight on the 1st of July
     * is the evening of the 30th of June in UTC, so a residency beginning on
     * the 1st would read as starting after a whole day booked on the 1st.
     */
    expect(instantAt(summerDay, 0)?.toISOString()).toBe(
      "2027-06-30T22:00:00.000Z",
    );
  });

  it("agrees with the day an instant is read back as", () => {
    const justAfterLocalMidnight = new Date("2027-06-30T22:30:00.000Z");

    expect(dateColumnOf(localDayOf(justAfterLocalMidnight)).toISOString()).toBe(
      "2027-07-01T00:00:00.000Z",
    );
  });
});

describe("parsing a date", () => {
  it("accepts a real one, including a leap day", () => {
    expect(parseLocalDay("2028-02-29")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  it.each([
    ["a day that does not exist", "2027-02-30"],
    ["a month that does not exist", "2027-13-01"],
    ["an unpadded month", "2027-2-03"],
    ["an instant", "2027-02-03T10:00:00Z"],
    ["nothing at all", ""],
  ])("refuses %s", (_what, text) => {
    // The 30th of February would otherwise be read as the 2nd of March, so a
    // resident asking for a month that does not exist would silently get a
    // different one.
    expect(parseLocalDay(text)).toBeNull();
  });
});

describe("the calendar week", () => {
  it("starts on Monday", () => {
    const week = localWeekAround(new Date("2027-03-25T12:00:00.000Z"));
    expect(formatLocalDay(localDayOf(week.startsAt))).toBe("2027-03-22");
    expect(localMinuteOf(week.startsAt)).toBe(0);
  });

  it("keeps Sunday in the week that began the Monday before", () => {
    /*
     * The half a Sunday-based week gets wrong. A household booking on Saturday
     * and again on Sunday would be spending two weeks' allowance on one
     * weekend, which is not what "two a week" means to anybody living here.
     */
    const saturday = localWeekAround(new Date("2027-10-30T12:00:00.000Z"));
    const sunday = localWeekAround(new Date("2027-10-31T12:00:00.000Z"));
    expect(sunday.startsAt.toISOString()).toBe(saturday.startsAt.toISOString());
    expect(formatLocalDay(localDayOf(sunday.startsAt))).toBe("2027-10-25");
  });

  it("puts a Monday at the start of its own week", () => {
    const week = localWeekAround(new Date("2027-11-01T09:00:00.000Z"));
    expect(formatLocalDay(localDayOf(week.startsAt))).toBe("2027-11-01");
  });

  it("is 169 hours long over the Sunday the clocks go back", () => {
    // The week is the length the calendar says it is. A week computed as seven
    // times 24 hours would end an hour early and let one booking of the
    // following Monday be counted into it.
    const week = localWeekAround(new Date("2027-10-31T12:00:00.000Z"));
    expect(
      (week.endsAt.getTime() - week.startsAt.getTime()) / (60 * 60 * 1000),
    ).toBe(169);
    expect(formatLocalDay(localDayOf(week.endsAt))).toBe("2027-11-01");
  });

  it("is 167 hours long over the Sunday the clocks go forward", () => {
    const week = localWeekAround(new Date("2027-03-28T12:00:00.000Z"));
    expect(
      (week.endsAt.getTime() - week.startsAt.getTime()) / (60 * 60 * 1000),
    ).toBe(167);
  });
});

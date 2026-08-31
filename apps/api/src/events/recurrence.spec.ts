import { describe, expect, it } from "vitest";

import {
  formatLocalDay,
  localDayOf,
  type LocalDay,
} from "../bookings/stockholm-calendar";
import {
  checkRecurrenceSchedule,
  MAX_OCCURRENCES,
  occurrencePeriods,
  RECURRENCE_HORIZON_DAYS,
  type RecurrenceRule,
  recurrenceDays,
  type SeriesSchedule,
} from "./recurrence";

/**
 * The recurrence rule, tested against the calendar rather than against itself.
 *
 * Every expectation below is a date or an instant written out by hand from what
 * the calendar says, not a value read back from the generator. That matters more
 * here than almost anywhere: a recurrence generator's mistakes are
 * self-consistent - a cumulative month-end clamp produces a perfectly regular
 * sequence, just the wrong one - so a test that asserted "the same as last time"
 * would pass through exactly the bug it exists for.
 *
 * The calendar facts these assertions rest on:
 *
 *  - Sweden's clocks go forward on the last Sunday in March and back on the last
 *    Sunday in October. In 2027 those are the 28th of March and the 31st of
 *    October. So 10:00 in Stockholm is 09:00 UTC on the 21st of March 2027 and
 *    08:00 UTC on the 4th of April; 08:00 UTC on the 24th of October and 09:00
 *    UTC on the 7th of November.
 *  - 2028 is a leap year and 2029, 2030 and 2031 are not; 2032 is.
 *  - February has 28 days in 2027, April 30, and January, March, May, July,
 *    August, October and December 31.
 */

const TEN_IN_THE_MORNING = 10 * 60;
const ONE_HOUR = 60;

/** A schedule at ten in the morning for an hour, with the rule given. */
function at(
  firstOn: string,
  recurrence: RecurrenceRule | null,
  minute = TEN_IN_THE_MORNING,
  durationMinutes = ONE_HOUR,
): SeriesSchedule {
  return {
    firstOn: day(firstOn),
    startsAtMinute: minute,
    durationMinutes,
    recurrence,
  };
}

function day(text: string): LocalDay {
  const [year, month, dayOfMonth] = text.split("-").map(Number);
  return {
    year: year ?? 0,
    month: month ?? 0,
    day: dayOfMonth ?? 0,
  };
}

/** The dates a schedule names, as "YYYY-MM-DD" strings. */
function dates(schedule: SeriesSchedule): string[] {
  return recurrenceDays(schedule).map(formatLocalDay);
}

/** The instants a schedule names, as ISO strings. */
function starts(schedule: SeriesSchedule): string[] {
  return occurrencePeriods(schedule).map((period) =>
    period.startsAt.toISOString(),
  );
}

const WEEKLY = (
  interval: number,
  end: { count?: number; until?: string },
): RecurrenceRule => ({
  frequency: "WEEKLY",
  interval,
  count: end.count ?? null,
  until: end.until === undefined ? null : day(end.until),
});

const MONTHLY = (
  interval: number,
  end: { count?: number; until?: string },
): RecurrenceRule => ({
  frequency: "MONTHLY",
  interval,
  count: end.count ?? null,
  until: end.until === undefined ? null : day(end.until),
});

const ANNUAL = (
  interval: number,
  end: { count?: number; until?: string },
): RecurrenceRule => ({
  frequency: "ANNUAL",
  interval,
  count: end.count ?? null,
  until: end.until === undefined ? null : day(end.until),
});

describe("a series with no rule", () => {
  it("names exactly its own date", () => {
    expect(dates(at("2027-04-18", null))).toEqual(["2027-04-18"]);
  });

  it("is one period, at the time of day it states", () => {
    // 18 April 2027 is inside summer time, so 10:00 Stockholm is 08:00 UTC.
    expect(occurrencePeriods(at("2027-04-18", null))).toEqual([
      {
        startsAt: new Date("2027-04-18T08:00:00.000Z"),
        endsAt: new Date("2027-04-18T09:00:00.000Z"),
      },
    ]);
  });
});

describe("a weekly rule", () => {
  it("steps a whole week at a time, on the same weekday", () => {
    // 18 April 2027 is a Sunday; so are the four dates after it.
    expect(dates(at("2027-04-18", WEEKLY(1, { count: 5 })))).toEqual([
      "2027-04-18",
      "2027-04-25",
      "2027-05-02",
      "2027-05-09",
      "2027-05-16",
    ]);
  });

  it("steps by the interval it states", () => {
    expect(dates(at("2027-04-18", WEEKLY(2, { count: 4 })))).toEqual([
      "2027-04-18",
      "2027-05-02",
      "2027-05-16",
      "2027-05-30",
    ]);
  });

  it("stops on the date it is told to, inclusive", () => {
    expect(dates(at("2027-04-18", WEEKLY(1, { until: "2027-05-09" })))).toEqual(
      ["2027-04-18", "2027-04-25", "2027-05-02", "2027-05-09"],
    );
  });

  it("stops before an until date that no occurrence lands on", () => {
    // The 10th is a Monday: the rule's dates are Sundays, so the last one
    // inside the window is the 9th.
    expect(dates(at("2027-04-18", WEEKLY(1, { until: "2027-05-10" })))).toEqual(
      ["2027-04-18", "2027-04-25", "2027-05-02", "2027-05-09"],
    );
  });
});

describe("the month-end rule", () => {
  /*
   * The case that decides whether the generator is right. Clamping to the last
   * day of the month is the rule; applying it to the previous occurrence rather
   * than to the first date is the bug, and it shows up here as February keeping
   * the series on the 28th for the rest of the year.
   */
  it("clamps a monthly series on the 31st and returns to the 31st afterwards", () => {
    expect(dates(at("2027-01-31", MONTHLY(1, { count: 14 })))).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
      "2027-10-31",
      "2027-11-30",
      "2027-12-31",
      "2028-01-31",
      // 2028 is a leap year, so February has 29 days and the clamp lands there.
      "2028-02-29",
    ]);
  });

  it("clamps a monthly series on the 30th only in February", () => {
    expect(dates(at("2027-01-30", MONTHLY(1, { count: 4 })))).toEqual([
      "2027-01-30",
      "2027-02-28",
      "2027-03-30",
      "2027-04-30",
    ]);
  });

  it("leaves a monthly series on the 28th alone", () => {
    expect(dates(at("2027-01-28", MONTHLY(1, { count: 4 })))).toEqual([
      "2027-01-28",
      "2027-02-28",
      "2027-03-28",
      "2027-04-28",
    ]);
  });

  it("carries the clamp across a year boundary with an interval", () => {
    expect(dates(at("2027-10-31", MONTHLY(2, { count: 4 })))).toEqual([
      "2027-10-31",
      "2027-12-31",
      "2028-02-29",
      "2028-04-30",
    ]);
  });
});

describe("the leap day", () => {
  it("falls back to the 28th in a common year and returns in a leap year", () => {
    expect(dates(at("2028-02-29", ANNUAL(1, { count: 9 })))).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
      "2033-02-28",
      "2034-02-28",
      "2035-02-28",
      "2036-02-29",
    ]);
  });

  it("keeps a leap-day series on the 29th when it repeats every four years", () => {
    expect(dates(at("2028-02-29", ANNUAL(4, { count: 3 })))).toEqual([
      "2028-02-29",
      "2032-02-29",
      "2036-02-29",
    ]);
  });

  it("leaves an annual series on an ordinary date alone", () => {
    expect(dates(at("2027-05-15", ANNUAL(1, { count: 3 })))).toEqual([
      "2027-05-15",
      "2028-05-15",
      "2029-05-15",
    ]);
  });
});

describe("daylight saving", () => {
  /*
   * Ten in the morning is ten in the morning on every occurrence. The instants
   * below are written out from the offsets in force: UTC+1 before the last
   * Sunday in March and after the last Sunday in October, UTC+2 between them.
   */
  it("keeps the time of day across the March change, moving the instant", () => {
    expect(starts(at("2027-03-21", WEEKLY(1, { count: 3 })))).toEqual([
      // Winter time: 10:00 Stockholm is 09:00 UTC.
      "2027-03-21T09:00:00.000Z",
      // The 23-hour Sunday itself: the clocks went forward at 02:00, so 10:00
      // is already summer time.
      "2027-03-28T08:00:00.000Z",
      "2027-04-04T08:00:00.000Z",
    ]);
  });

  it("keeps the time of day across the October change, moving the instant", () => {
    expect(starts(at("2027-10-24", WEEKLY(1, { count: 3 })))).toEqual([
      // Summer time: 10:00 Stockholm is 08:00 UTC.
      "2027-10-24T08:00:00.000Z",
      // The 25-hour Sunday: the clocks went back at 03:00, so 10:00 is winter
      // time.
      "2027-10-31T09:00:00.000Z",
      "2027-11-07T09:00:00.000Z",
    ]);
  });

  it("does not step by a fixed number of hours", () => {
    /*
     * The property the two tests above rest on, stated on its own: the gap
     * between consecutive occurrences is not seven days of clock time when a
     * change falls between them. A generator that added 7 * 24 hours to an
     * instant would produce 168 for every pair.
     */
    const periods = occurrencePeriods(
      at("2027-03-21", WEEKLY(1, { count: 3 })),
    );
    const hours = periods
      .slice(1)
      .map(
        (period, index) =>
          (period.startsAt.getTime() -
            (periods[index]?.startsAt.getTime() ?? 0)) /
          3_600_000,
      );
    expect(hours).toEqual([167, 168]);
  });

  it("keeps a whole-day event a whole wall-clock day across the change", () => {
    // Midnight to midnight on the 23-hour Sunday is 23 real hours long, which
    // is what the calendar says that day is.
    const [period] = occurrencePeriods(at("2027-03-28", null, 0, 24 * 60));
    expect(period?.startsAt.toISOString()).toBe("2027-03-27T23:00:00.000Z");
    expect(period?.endsAt.toISOString()).toBe("2027-03-28T22:00:00.000Z");
  });

  it("takes the first of the two readings on the repeated hour", () => {
    // 02:30 happens twice on the 31st of October 2027. The first is 00:30 UTC.
    const [period] = occurrencePeriods(at("2027-10-31", null, 150, 30));
    expect(period?.startsAt.toISOString()).toBe("2027-10-31T00:30:00.000Z");
  });

  it("leaves out a later occurrence the clocks jumped over", () => {
    /*
     * A weekly 02:30 series crossing the March change. The wall clock never
     * reads 02:30 on the 28th, so there is no instant to answer with and the
     * date is left out rather than moved an hour from where it was asked for.
     */
    const schedule = at("2027-03-21", WEEKLY(1, { count: 3 }), 150, 30);
    expect(dates(schedule)).toEqual(["2027-03-21", "2027-03-28", "2027-04-04"]);
    expect(
      occurrencePeriods(schedule).map((period) =>
        formatLocalDay(localDayOf(period.startsAt)),
      ),
    ).toEqual(["2027-03-21", "2027-04-04"]);
  });

  it("refuses a first occurrence the clocks jumped over", () => {
    expect(checkRecurrenceSchedule(at("2027-03-28", null, 150, 30))).toBe(
      "start-does-not-exist",
    );
  });

  it("refuses a first occurrence whose end the clocks jumped over", () => {
    // 01:30 exists on the 28th; 02:30, half an hour of wall clock later, does
    // not.
    expect(checkRecurrenceSchedule(at("2027-03-28", null, 90, 60))).toBe(
      "start-does-not-exist",
    );
  });
});

describe("an event running past midnight", () => {
  it("ends on the following day", () => {
    // Midsummer, 20:00 for five hours. Summer time, so 20:00 is 18:00 UTC.
    const [period] = occurrencePeriods(at("2027-06-25", null, 20 * 60, 300));
    expect(period?.startsAt.toISOString()).toBe("2027-06-25T18:00:00.000Z");
    expect(period?.endsAt.toISOString()).toBe("2027-06-25T23:00:00.000Z");
    expect(formatLocalDay(localDayOf(period?.endsAt ?? new Date(0)))).toBe(
      "2027-06-26",
    );
  });
});

describe("the rule's own bounds", () => {
  it("accepts a rule with a count and nothing else", () => {
    expect(
      checkRecurrenceSchedule(at("2027-04-18", WEEKLY(1, { count: 5 }))),
    ).toBe(null);
  });

  it("accepts a rule with an until date and nothing else", () => {
    expect(
      checkRecurrenceSchedule(
        at("2027-04-18", WEEKLY(1, { until: "2027-06-06" })),
      ),
    ).toBe(null);
  });

  it("refuses a rule with no end at all", () => {
    expect(checkRecurrenceSchedule(at("2027-04-18", WEEKLY(1, {})))).toBe(
      "recurrence-end-required",
    );
  });

  it("refuses a rule with both ends", () => {
    expect(
      checkRecurrenceSchedule(
        at("2027-04-18", WEEKLY(1, { count: 5, until: "2027-06-06" })),
      ),
    ).toBe("recurrence-end-ambiguous");
  });

  it("refuses a count of one, which is not a repetition", () => {
    expect(
      checkRecurrenceSchedule(at("2027-04-18", WEEKLY(1, { count: 1 }))),
    ).toBe("recurrence-end-invalid");
  });

  it("refuses an until date before the first occurrence", () => {
    expect(
      checkRecurrenceSchedule(
        at("2027-04-18", WEEKLY(1, { until: "2027-04-11" })),
      ),
    ).toBe("recurrence-end-invalid");
  });

  it("refuses an until date the rule never reaches", () => {
    // Weekly from the 18th, ending on the 20th: the second occurrence is the
    // 25th, so the rule names one date and repeats nothing.
    expect(
      checkRecurrenceSchedule(
        at("2027-04-18", WEEKLY(1, { until: "2027-04-20" })),
      ),
    ).toBe("recurrence-end-invalid");
  });

  it("refuses an interval below one", () => {
    expect(
      checkRecurrenceSchedule(at("2027-04-18", WEEKLY(0, { count: 5 }))),
    ).toBe("recurrence-interval-invalid");
  });

  it("refuses a duration of nothing and one longer than a day", () => {
    expect(checkRecurrenceSchedule(at("2027-04-18", null, 600, 0))).toBe(
      "duration-invalid",
    );
    expect(
      checkRecurrenceSchedule(at("2027-04-18", null, 600, 24 * 60 + 1)),
    ).toBe("duration-invalid");
  });
});

describe("the two-year horizon", () => {
  it("accepts an until date on the last day inside it", () => {
    /*
     * 731 days after the 18th of April 2027, counted on the calendar: 257 days
     * are left of 2027 after the 18th of April, 2028 has 366, and
     * 731 - 257 - 366 = 108 days into 2029, which is the 18th of April. So the
     * window is exactly two years here, because it contains the 29th of
     * February 2028.
     */
    expect(
      checkRecurrenceSchedule(
        at("2027-04-18", MONTHLY(1, { until: "2029-04-18" })),
      ),
    ).toBe(null);
  });

  it("refuses an until date one day past it", () => {
    expect(
      checkRecurrenceSchedule(
        at("2027-04-18", MONTHLY(1, { until: "2029-04-19" })),
      ),
    ).toBe("recurrence-past-horizon");
  });

  it("refuses a count whose last occurrence lands past it", () => {
    // Monthly for 26 occurrences from the 18th of April 2027 ends on the 18th
    // of May 2029, a month past the horizon; 25 ends on it exactly.
    expect(
      checkRecurrenceSchedule(at("2027-04-18", MONTHLY(1, { count: 26 }))),
    ).toBe("recurrence-past-horizon");
    expect(
      checkRecurrenceSchedule(at("2027-04-18", MONTHLY(1, { count: 25 }))),
    ).toBe(null);
  });

  it("lets an annual series hold three dates and refuses a fourth", () => {
    // Two years' worth is the first date and the two anniversaries after it,
    // which is what the extra day in the horizon is there to guarantee.
    expect(
      checkRecurrenceSchedule(at("2027-05-15", ANNUAL(1, { count: 3 }))),
    ).toBe(null);
    expect(
      recurrenceDays(at("2027-05-15", ANNUAL(1, { count: 3 }))),
    ).toHaveLength(3);
    expect(
      checkRecurrenceSchedule(at("2027-05-15", ANNUAL(1, { count: 4 }))),
    ).toBe("recurrence-past-horizon");
  });

  it("holds the densest rule the module offers", () => {
    /*
     * Weekly with an interval of one is the most occurrences a rule can name,
     * and MAX_OCCURRENCES is derived from that rather than chosen: the horizon
     * holds day 0 through day 728, which is 105 Sundays.
     */
    expect(MAX_OCCURRENCES).toBe(Math.floor(RECURRENCE_HORIZON_DAYS / 7) + 1);
    const accepted = at("2027-04-18", WEEKLY(1, { count: MAX_OCCURRENCES }));
    expect(checkRecurrenceSchedule(accepted)).toBe(null);
    expect(recurrenceDays(accepted)).toHaveLength(MAX_OCCURRENCES);
    expect(
      checkRecurrenceSchedule(
        at("2027-04-18", WEEKLY(1, { count: MAX_OCCURRENCES + 1 })),
      ),
    ).toBe("recurrence-past-horizon");
  });

  it("stops the generator even for a rule that was never checked", () => {
    /*
     * The belt. A row edited into an impossible state by hand - a count far past
     * anything checkRecurrenceSchedule would accept - stops rather than looping,
     * and answers with as many dates as the module will hold.
     */
    const days = recurrenceDays(at("2027-04-18", WEEKLY(1, { count: 10_000 })));
    expect(days).toHaveLength(MAX_OCCURRENCES);
    expect(formatLocalDay(days.at(-1) ?? day("1970-01-01"))).toBe("2029-04-15");
  });
});

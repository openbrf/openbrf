/**
 * The wall clock the association's calendar is read against.
 *
 * Every booking in this module is stated twice: as an instant, which is what
 * the database stores and compares, and as a time of day somebody reads off a
 * notice in the stairwell. The two are not the same arithmetic. A laundry room
 * opens at seven every morning, including the two mornings a year that are 23
 * and 25 hours long, so "seven o'clock" is a calendar fact and the instant it
 * names moves by an hour twice a year.
 *
 * These functions are the only place that conversion happens. Adding hours to
 * an instant, or reading local fields off a `Date` with `getHours()`, would
 * both give the server's own zone rather than the association's, and both would
 * be right in Stockholm in July and wrong in the last week of October.
 *
 * ## What the two transitions do
 *
 * On the last Sunday in March the clocks go from 02:00 to 03:00, so the local
 * times 02:00 to 02:59 do not happen at all. {@link instantAt} answers null for
 * them, because there is no instant to answer with and inventing one would put
 * a booking an hour from where it was asked for.
 *
 * On the last Sunday in October the clocks go from 03:00 back to 02:00, so
 * 02:00 to 02:59 happen twice. {@link instantAt} answers the first of the two.
 * The alternative - offering both - would give a resident two rows reading
 * 02:30 with no way to tell them apart, and a slot the board could not describe
 * on a timetable. Taking the first means the hour the wall clock spends
 * repeating belongs to the slot that was already running, which is what a
 * printed timetable says too.
 *
 * ## Why no library
 *
 * `Intl.DateTimeFormat` carries the zone database Node already ships, and the
 * conversion below is a round trip through it rather than arithmetic over
 * offsets this file would have to keep up to date. Nothing here knows that
 * Sweden is on CET or that the rule changes on a Sunday; if the European Union
 * abolishes the change, this keeps working the day Node's data does.
 */

/**
 * The calendar the association dates things by.
 *
 * The same zone the website prints published dates in and the mail templates
 * format with. A cooperative is a building in one place, so this is a constant
 * rather than a setting: an association is not partly in another time zone, and
 * a board that could change it would only ever change it by mistake.
 */
export const ASSOCIATION_TIME_ZONE = "Europe/Stockholm";

/** Minutes in a nominal day, which is the bound on a time of day and a slot. */
export const MINUTES_PER_DAY = 24 * 60;

const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_DAY = MINUTES_PER_DAY * MILLISECONDS_PER_MINUTE;

/**
 * A date on the Stockholm wall calendar.
 *
 * Fields rather than a `Date`, because a `Date` is an instant and a calendar
 * date is not one: "the 25th of October" is a different length in seconds
 * depending on the year, and a type that could be mistaken for an instant is a
 * type somebody will do instant arithmetic on.
 *
 * `month` is 1 to 12, as it is written, and not the 0 to 11 the `Date`
 * constructor takes. Every conversion to that convention happens inside this
 * file.
 */
export interface LocalDay {
  year: number;
  month: number;
  day: number;
}

/** The booked period a slot or a booking covers, as instants. */
export interface Period {
  startsAt: Date;
  endsAt: Date;
}

/**
 * The formatter every conversion goes through.
 *
 * Built once: constructing one is expensive enough to show up when a month of
 * slots is generated, and this one is stateless.
 *
 * `calendar: "gregory"` and `hourCycle: "h23"` are stated rather than left to
 * the locale. A locale can carry a non-Gregorian calendar, and the h11/h12
 * cycles render midnight as 12 and h24 renders it as 24, so a formatter that
 * inherited either would answer a different number for the same instant
 * depending on where the process was started.
 */
const STOCKHOLM_FIELDS = new Intl.DateTimeFormat("en-US", {
  timeZone: ASSOCIATION_TIME_ZONE,
  calendar: "gregory",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface LocalFields extends LocalDay {
  /** Minutes past midnight on the local wall clock, 0 to 1439. */
  minuteOfDay: number;
}

/** The local calendar fields of an instant. */
function fieldsAt(instant: number): LocalFields {
  const parts = STOCKHOLM_FIELDS.formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    minuteOfDay: value("hour") * 60 + value("minute"),
  };
}

/**
 * How far ahead of UTC the association's clock is at an instant.
 *
 * Measured rather than looked up: the same instant is formatted in the zone and
 * the resulting fields are read back as though they were UTC, and the
 * difference is the offset in force. Both sides are whole minutes - Sweden has
 * been on a whole-minute offset since 1900 - so the division is exact.
 *
 * @param instant A whole number of minutes since the epoch, which every caller
 *   in this file passes because both the pseudo-instant and the probes are
 *   built from minute arithmetic.
 */
function offsetMinutesAt(instant: number): number {
  const fields = fieldsAt(instant);
  const asIfUtc =
    Date.UTC(fields.year, fields.month - 1, fields.day) +
    fields.minuteOfDay * MILLISECONDS_PER_MINUTE;
  return Math.round((asIfUtc - instant) / MILLISECONDS_PER_MINUTE);
}

/** Whether an instant is exactly this local date and time of day. */
function isLocally(
  instant: number,
  day: LocalDay,
  minuteOfDay: number,
): boolean {
  const fields = fieldsAt(instant);
  return (
    fields.year === day.year &&
    fields.month === day.month &&
    fields.day === day.day &&
    fields.minuteOfDay === minuteOfDay
  );
}

/**
 * The instant a local time of day names, or null when it never happens.
 *
 * The whole of the daylight saving handling in this module. A local date and a
 * minute past midnight are read as UTC to get a pseudo-instant, and the two
 * offsets in force a day either side of it give two candidates. Whichever
 * candidate formats back to the local time that was asked for is the answer;
 * when both do, the local time happens twice and the earlier is taken; when
 * neither does, the clocks jumped over it and there is no answer.
 *
 * A day either side is far enough: the association's clock changes at most once
 * in any 48 hours, so one probe is always before the change and the other
 * always after it, whichever side of it the requested time falls.
 *
 * @param minuteOfDay Minutes past local midnight. Values of 1440 and above roll
 *   into the following days, so a resource closing at 1440 asks for the next
 *   midnight and gets it rather than an hour that does not exist.
 */
export function instantAt(day: LocalDay, minuteOfDay: number): Date | null {
  const shift = Math.floor(minuteOfDay / MINUTES_PER_DAY);
  const minute = minuteOfDay - shift * MINUTES_PER_DAY;
  const on = shift === 0 ? day : addLocalDays(day, shift);

  const asIfUtc =
    Date.UTC(on.year, on.month - 1, on.day) + minute * MILLISECONDS_PER_MINUTE;
  const before =
    asIfUtc -
    offsetMinutesAt(asIfUtc - MILLISECONDS_PER_DAY) * MILLISECONDS_PER_MINUTE;
  const after =
    asIfUtc -
    offsetMinutesAt(asIfUtc + MILLISECONDS_PER_DAY) * MILLISECONDS_PER_MINUTE;

  if (isLocally(before, on, minute)) {
    // The ordinary answer, and on the October Sunday the first of the two
    // times the clock reads this.
    return new Date(before);
  }
  if (before !== after && isLocally(after, on, minute)) {
    return new Date(after);
  }
  // Neither candidate reads back as the time that was asked for, which happens
  // only on the March Sunday between 02:00 and 03:00.
  return null;
}

/** The Stockholm calendar date an instant falls on. */
export function localDayOf(instant: Date): LocalDay {
  const fields = fieldsAt(instant.getTime());
  return { year: fields.year, month: fields.month, day: fields.day };
}

/** The minute past local midnight an instant falls on, 0 to 1439. */
export function localMinuteOf(instant: Date): number {
  return fieldsAt(instant.getTime()).minuteOfDay;
}

/**
 * A calendar date shifted by whole days.
 *
 * Calendar arithmetic and not instant arithmetic: adding a day to the 28th of
 * October is the 29th whether that day is 23, 24 or 25 hours long. Done through
 * `Date.UTC`, which is the proleptic Gregorian calendar and carries no zone at
 * all, so leap years and month lengths come from the platform rather than from
 * a table here.
 */
export function addLocalDays(day: LocalDay, days: number): LocalDay {
  const shifted = new Date(
    Date.UTC(day.year, day.month - 1, day.day) + days * MILLISECONDS_PER_DAY,
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Negative, zero or positive as the first date is before, on or after. */
export function compareLocalDays(first: LocalDay, second: LocalDay): number {
  return (
    Date.UTC(first.year, first.month - 1, first.day) -
    Date.UTC(second.year, second.month - 1, second.day)
  );
}

/** Whole days from the first date to the second, negative when it is earlier. */
export function localDaysBetween(from: LocalDay, to: LocalDay): number {
  return Math.round(compareLocalDays(to, from) / MILLISECONDS_PER_DAY);
}

/** "YYYY-MM-DD", the form a request and a response state a date in. */
export function formatLocalDay(day: LocalDay): string {
  return (
    `${String(day.year).padStart(4, "0")}-` +
    `${String(day.month).padStart(2, "0")}-` +
    `${String(day.day).padStart(2, "0")}`
  );
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A "YYYY-MM-DD" date, or null when the text is not one.
 *
 * Strict about the shape and about the date being real: `Date.parse` would
 * accept "2026-02-30" and answer the 2nd of March, so a resident asking for a
 * month that does not exist would silently get a different one. The round trip
 * through {@link formatLocalDay} is what refuses that.
 */
export function parseLocalDay(text: string): LocalDay | null {
  const match = DAY_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const day: LocalDay = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return formatLocalDay(normalise(day)) === text ? day : null;
}

/** The date as the calendar has it, so the 30th of February becomes March. */
function normalise(day: LocalDay): LocalDay {
  return addLocalDays(day, 0);
}

/**
 * The calendar week an instant falls in, Monday to Monday.
 *
 * Monday, because Sweden numbers and starts its weeks the ISO 8601 way and a
 * "bookings per week" limit is read against the week a resident already has in
 * their head. A Sunday-based week would move the boundary into the middle of a
 * weekend, so a household booking Saturday and Sunday would be spending two
 * different weeks' allowances on one weekend.
 *
 * The bounds are instants, so the week over the October Sunday is 169 hours
 * long and the one over the March Sunday 167. That is correct: the limit counts
 * bookings inside a calendar week, and those weeks are the length the calendar
 * says.
 *
 * @returns The Monday 00:00 that opens the week and the Monday 00:00 that
 *   closes it, the second exclusive.
 */
export function localWeekAround(instant: Date): Period {
  const day = localDayOf(instant);
  // 0 is Sunday from getUTCDay, and the week starts on Monday, so rotate.
  const weekday =
    (new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() + 6) % 7;

  const monday = addLocalDays(day, -weekday);
  const startsAt = instantAt(monday, 0);
  const endsAt = instantAt(addLocalDays(monday, 7), 0);

  /* c8 ignore next 6 -- unreachable: Sweden's clock has never skipped midnight */
  if (startsAt === null || endsAt === null) {
    throw new Error(
      `No local midnight bounds the week of ${formatLocalDay(day)}.`,
    );
  }
  return { startsAt, endsAt };
}

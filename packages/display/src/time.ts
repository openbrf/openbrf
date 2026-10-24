/**
 * Instants and the calendar day of a time zone, with nothing but `Intl`.
 *
 * The association's day is the document's `timeZone`, never the browser's:
 * a screen whose clock is set to another zone still shows Stockholm's today.
 */
import type { Instant, IsoWeekday } from "./contract.ts";

/** A calendar date and a time of day, as a wall clock in one zone shows it. */
export interface ZonedParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** 0 to 23. */
  hour: number;
  minute: number;
  second: number;
  weekday: IsoWeekday;
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `Intl` knows the zone. */
export function isTimeZone(timeZone: string): boolean {
  try {
    partFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `timeZone` at an instant. */
export function zonedParts(time: number, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of partFormatter(timeZone).formatToParts(time)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  const year = values["year"] ?? 1970;
  const month = values["month"] ?? 1;
  const day = values["day"] ?? 1;
  return {
    year,
    month,
    day,
    hour: (values["hour"] ?? 0) % 24,
    minute: values["minute"] ?? 0,
    second: values["second"] ?? 0,
    weekday: isoWeekday(year, month, day),
  };
}

function isoWeekday(year: number, month: number, day: number): IsoWeekday {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (weekday === 0 ? 7 : weekday) as IsoWeekday;
}

/** How far the zone's wall clock is ahead of UTC at an instant, in ms. */
function offset(time: number, timeZone: string): number {
  const parts = zonedParts(time, timeZone);
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(time / 1000) * 1000;
}

/**
 * The first instant of a calendar date in `timeZone`: its midnight, or, in a
 * zone that skips midnight on the day the clocks go forward, the moment the
 * day begins.
 */
export function zonedDayStart(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offset(wall, timeZone);
  const second = wall - offset(first, timeZone);
  const onTheDay = [first, second]
    .filter((candidate) => {
      const parts = zonedParts(candidate, timeZone);
      return parts.year === year && parts.month === month && parts.day === day;
    })
    .sort((a, b) => a - b);
  return onTheDay[0] ?? Math.max(first, second);
}

/** The first instant of the calendar day `days` after the one `time` falls on. */
export function zonedDayStartAfter(
  time: number,
  days: number,
  timeZone: string,
): number {
  const today = zonedParts(time, timeZone);
  const date = new Date(
    Date.UTC(today.year, today.month - 1, today.day + days),
  );
  return zonedDayStart(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    timeZone,
  );
}

/** An instant floored to its minute. */
export function floorToMinute(time: number): number {
  return Math.floor(time / MINUTE) * MINUTE;
}

/** An instant as the contract writes one: UTC, whole seconds, "Z". */
export function toInstant(time: number): Instant {
  return `${new Date(Math.floor(time / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

export { DAY, MINUTE };

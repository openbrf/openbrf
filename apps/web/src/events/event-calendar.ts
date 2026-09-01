/**
 * Reading an event's dates in the browser.
 *
 * The server owns every calendar decision this module rests on: which dates a
 * series falls on, which local day each of them belongs to, whether one has
 * begun, and how far ahead the calendar reaches. An occurrence arrives with its
 * instants, with the association's own date already worked out and with that
 * comparison already made, so nothing here decides anything about an event.
 *
 * What is left is the part a browser has to do, and there is one piece of it the
 * booking calendar does not already cover: naming a bare date with its year. A
 * booking window is a week or four and can be read without one; the event
 * calendar reaches half a year ahead, so it crosses a new year and a date read
 * as "onsdag 7 januari" would be ambiguous exactly when a board is planning.
 *
 * Everything else comes from `bookings/booking-calendar.ts` rather than being
 * written again. Turning an instant into the time the stairwell clock reads is
 * one question with one answer, and a second copy of it in this module could
 * disagree with the first - which the register screen already settled by
 * importing `localDayNow` from there instead of restating it.
 */

/** "YYYY-MM-DD", the form the API states an occurrence's local date in. */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar date as a person reads it: "onsdag 7 januari 2027".
 *
 * The weekday is there because that is how somebody reads a cleaning day, and
 * the year is there because this calendar reaches past a new year. Text that is
 * not a real date is answered unchanged rather than being turned into a
 * different real date: `Date.UTC` reads the 40th of a month as the month after,
 * so the round trip below is what refuses "2026-13-40" instead of rendering it
 * as a day in February 2027.
 */
export function formatEventDay(day: string, locale: string): string {
  const value = instantOfNoon(day);
  return value === null
    ? day
    : new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        // The value below is noon UTC standing in for a bare date, so the
        // formatter is told UTC and never the association's zone: reading a
        // date as an instant in Stockholm is what puts it on the day before.
        timeZone: "UTC",
      }).format(value);
}

/**
 * A time of day as minutes past local midnight, from a time field's value.
 *
 * Minutes rather than an instant, because that is what the API takes: a series
 * states the time of day it happens at, and the server turns it into an instant
 * per date on the association's clock. Assembling the instant here would be
 * wrong on the two dates a year the wall clock moves.
 */
export function minuteOfTimeValue(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  /*
   * Both halves bounded, and not only the total. "24:00" is the following
   * midnight rather than a time of day, and would put the first date a day late;
   * "10:99" adds up to a minute inside the day and is not a reading of a clock
   * at all. The API bounds this as well, because a request is not the only way a
   * row is written.
   */
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

/** Minutes past local midnight as a time field's value, so 600 is "10:00". */
export function timeValueOfMinute(minute: number): string {
  const wrapped = ((minute % (24 * 60)) + 24 * 60) % (24 * 60);
  return (
    `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:` +
    `${String(wrapped % 60).padStart(2, "0")}`
  );
}

/**
 * A date understood as noon UTC, for formatting a bare calendar date.
 *
 * Noon rather than midnight, so no zone the formatter could be handed puts the
 * date on the day before or after. The same construction the booking calendar
 * uses, for the same reason.
 */
function instantOfNoon(day: string): Date | null {
  const match = DAY_PATTERN.exec(day);
  if (match === null) {
    return null;
  }
  const value = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
  );
  return formatUtcDay(value) === day ? value : null;
}

/** The calendar fields of an instant read as UTC, as "YYYY-MM-DD". */
function formatUtcDay(instant: Date): string {
  return (
    `${String(instant.getUTCFullYear()).padStart(4, "0")}-` +
    `${String(instant.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(instant.getUTCDate()).padStart(2, "0")}`
  );
}

/**
 * Reading the association's clock in the browser.
 *
 * The server owns every calendar decision: which slots exist, which day a slot
 * belongs to, and what a week is. A slot arrives with its instants and with the
 * Stockholm date it opens on already worked out, so nothing here decides
 * anything about a booking. What is left is the part a browser has to do -
 * turning an instant into the time a resident reads, and naming the window to
 * ask for next.
 *
 * ## No offset is derived here
 *
 * Every conversion between an instant and a wall-clock reading goes through
 * `Intl.DateTimeFormat` with the association's zone, which reads the platform's
 * own time-zone database. Adding or subtracting hours would be the mistake this
 * avoids: the two Sundays a year that are 23 and 25 hours long are exactly when
 * a laundry booking matters, and an arithmetic offset is wrong on both of them.
 *
 * Date arithmetic is separate and deliberately carries no zone at all. Shifting
 * a "YYYY-MM-DD" by a day is a question about the calendar - the day after the
 * 28th of October is the 29th whether that day is 23, 24 or 25 hours long - so
 * it is done through `Date.UTC`, which is the proleptic Gregorian calendar and
 * nothing else. That is the same construction the server's own calendar module
 * uses, for the same reason.
 */

/**
 * The association's clock, as the API states it.
 *
 * Mirrored rather than imported, like every other wire constant here: the
 * browser and the server are separate builds. It is the one place in the client
 * that names a zone, so a screen cannot quietly render a booking in the
 * viewer's own.
 */
export const ASSOCIATION_TIME_ZONE = "Europe/Stockholm";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD", the form a calendar request and a slot state a date in. */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * How many days a resource's calendar shows at once.
 *
 * A week of a laundry room, because a resident reads a laundry calendar as this
 * week and next; four weeks of anything booked by the day, because a common room
 * and a guest apartment are planned a month out. Both are well inside the 62
 * days one request may ask for, which the API refuses beyond.
 */
export function windowDaysFor(mode: string): number {
  return mode === "TIME_SLOTS" ? 7 : 28;
}

/**
 * The Stockholm calendar date it is now.
 *
 * Read from the platform's time-zone database rather than from the viewer's own
 * clock reading: a board member in another country still books against the
 * building's day, and just after midnight in Stockholm the two disagree.
 */
export function localDayNow(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ASSOCIATION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const field = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${field("year")}-${field("month")}-${field("day")}`;
}

/**
 * A "YYYY-MM-DD" date shifted by whole days.
 *
 * Calendar arithmetic and never instant arithmetic; see the file comment.
 *
 * Text that is not a real date is answered unchanged, so a malformed value from
 * a response cannot turn into a different real date on its way into a request.
 * The shape alone is not enough to tell: `Date.UTC` reads month 13 as January
 * of the next year and the 40th of a month as the month after, so "2026-13-40"
 * would otherwise come back as a date in February 2027 that nobody asked for.
 * The round trip below is what refuses that, and it is the rule the server's
 * own parser applies to the same text.
 */
export function shiftLocalDay(day: string, days: number): string {
  const match = DAY_PATTERN.exec(day);
  if (match === null) {
    return day;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (formatUtcDay(new Date(Date.UTC(year, month - 1, date))) !== day) {
    return day;
  }
  return formatUtcDay(
    new Date(Date.UTC(year, month - 1, date) + days * MILLISECONDS_PER_DAY),
  );
}

/** The calendar fields of an instant read as UTC, as "YYYY-MM-DD". */
function formatUtcDay(instant: Date): string {
  return (
    `${String(instant.getUTCFullYear()).padStart(4, "0")}-` +
    `${String(instant.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(instant.getUTCDate()).padStart(2, "0")}`
  );
}

/** Negative, zero or positive as the first date is before, on or after. */
export function compareLocalDays(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

/**
 * The time of day an instant reads as on the association's clock, "07:00".
 *
 * The clock and not the date, because this labels a slot inside a day the grid
 * has already named. On the March Sunday the slot after 01:00 reads 03:00,
 * which is what the wall clock in the laundry room says.
 */
export function formatTimeOfDay(instant: string, locale: string): string {
  const value = new Date(instant);
  return Number.isNaN(value.getTime())
    ? instant
    : new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: ASSOCIATION_TIME_ZONE,
      }).format(value);
}

/**
 * A calendar date as a person reads it: "onsdag 16 september".
 *
 * The weekday is there because that is how a resident picks a laundry hour, and
 * the year is not, because a calendar showing four weeks never spans two years
 * in a way the reader is in doubt about. `formatBookingDate` carries the year
 * for the places that list a booking on its own.
 */
export function formatDayWithWeekday(day: string, locale: string): string {
  const value = instantOfNoon(day);
  return value === null
    ? day
    : new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }).format(value);
}

/** A calendar date with its year, for a booking listed on its own. */
export function formatBookingDate(instant: string, locale: string): string {
  const value = new Date(instant);
  return Number.isNaN(value.getTime())
    ? instant
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: ASSOCIATION_TIME_ZONE,
      }).format(value);
}

/**
 * A date understood as noon UTC, for formatting a bare calendar date.
 *
 * Noon rather than midnight, so no zone the formatter could be handed puts the
 * date on the day before or after. The formatter above is told UTC in any case;
 * this is belt and braces on a value that is a date and not an instant, and it
 * is why nothing in this file formats a bare date in the association's zone.
 */
function instantOfNoon(day: string): Date | null {
  const match = DAY_PATTERN.exec(day);
  if (match === null) {
    return null;
  }
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
  );
}

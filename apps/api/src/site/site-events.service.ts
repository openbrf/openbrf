import { Injectable } from "@nestjs/common";

import { instantAt, localDayOf } from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";

/**
 * The association's calendar, as the public website reads it.
 *
 * Reads only, and the twin of SiteNewsService in every way that matters. It
 * answers three questions - what is coming, what falls in this month, and what
 * one event is - and the third of them is answered with a single null for "no
 * such event", "not published" and "members only", so the controller has one
 * answer to give and cannot leak which case it was in.
 *
 * The writing half lives in src/events, outside this directory, because it
 * records who entered a series, keeps the sign-ups and writes the audit log.
 * The boundary that keeps the statutory registers out of the public website is
 * the module graph, and it holds here exactly as it holds for the news: this
 * file imports the database client and the calendar conversion and nothing
 * else.
 *
 * ## A count is the most this file can produce about who is coming
 *
 * Sign-ups (anmälan) are personal data about the association's own residents and
 * the roll-call is behind events:manage. The website may say how many places are
 * gone and never whose they are, and that is enforced by the shape of the query
 * rather than by what the renderer chooses to print: the places are read as a
 * filtered relation count, so the only thing this module can learn about a
 * sign-up is how many of them there are. There is no select of `personId`
 * anywhere in this file, and no shape below has anywhere to put one.
 *
 * ## Why the visibility rule is one line
 *
 * Whether a reader sees the members' events rests on one boolean - whether the
 * request carried a session - exactly as it does for a page and a news item.
 * There is no capability read here and there cannot be: the website is the one
 * surface in the product with no capability check at all, and a second question
 * about who is asking would be a second answer for the two to disagree on.
 */

/**
 * One date in the calendar, as the website shows it.
 *
 * The series it belongs to rather than the occurrence's own identifier: the
 * address a date links to is the event's, because what a reader wants from a
 * cleaning day in April is the series that says what to bring and when the
 * others are. The occurrence id is not carried at all, so nothing on the
 * website can be keyed by it.
 */
export interface SiteEventDate {
  /** The series this date belongs to, and the address it links to. */
  eventId: string;
  /** The board's own words, stored as written and never translated. */
  title: string;
  category: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  /** Whether the board has called this one date off. */
  cancelled: boolean;
  /** Whether the series takes sign-ups at all. */
  signupOpen: boolean;
  /** Places at this date. Null is no limit. */
  capacity: number | null;
  /** Standing sign-ups at this date. A count, and never a name. */
  placesTaken: number;
}

/** One event in full, as its own page shows it. */
export interface SiteEvent {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  /** Every date in the series, earliest first, called-off ones included. */
  dates: SiteEventDate[];
}

/**
 * A month on the association's own calendar.
 *
 * `month` is 1 to 12, as it is written. Fields rather than a `Date` for the
 * reason {@link LocalDay} gives: a month is not an instant, and a type that
 * could be mistaken for one is a type somebody will do instant arithmetic on.
 */
export interface CalendarMonth {
  year: number;
  month: number;
}

/**
 * One month of the calendar, and where a reader may go from it.
 *
 * The two neighbours are resolved here rather than by the renderer, because
 * whether a month is inside the window this calendar answers for is the same
 * question the clamp asks and it must not be answered twice. Null is a month
 * the calendar does not reach, and the renderer then prints no anchor - a link
 * to a month that would be clamped back to this one is a link that does
 * nothing.
 */
export interface SiteCalendarPage {
  month: CalendarMonth;
  previous: CalendarMonth | null;
  next: CalendarMonth | null;
  dates: SiteEventDate[];
}

/**
 * The query parameter that names the month, in Swedish because the address is.
 *
 * /kalender?manad=2026-04 is what a prev or next anchor on the page produces
 * and the only thing about the request the page reads. It is not a preference
 * anything remembers: the website sets no cookie, so which month a reader is
 * looking at lives in the address bar and nowhere else.
 */
export const CALENDAR_MONTH_PARAM = "manad";

/**
 * How far back the calendar may be paged.
 *
 * A year. A public calendar is read forward - what is coming, what to plan
 * around - and a year of history is as far back as anybody looking for "when
 * was the last cleaning day" needs. The bound is also what stops the prev
 * anchor walking backwards without end.
 */
const CALENDAR_MONTHS_BACK = 12;

/**
 * How far forward the calendar may be paged.
 *
 * Two years, which is where the occurrences stop existing: a recurrence rule is
 * refused if it reaches further, so the rows a month past this could hold have
 * never been written. Paging into an empty month a reader could not have
 * reached any other way would be the calendar offering a door onto nothing.
 */
const CALENDAR_MONTHS_AHEAD = 24;

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * The month a "YYYY-MM" string names, or null when the text is not one.
 *
 * Strict, and strict about both halves. A four-digit year and a two-digit month
 * with the leading zero, so "2026-4" is refused rather than read as April: the
 * only thing that produces this parameter is an anchor this page printed, and
 * anything else is a visitor or a crawler guessing. A month of 00 or 13 is
 * refused for the same reason - clamping it to a real one would be answering a
 * question nobody asked.
 */
export function parseCalendarMonth(
  text: string | undefined,
): CalendarMonth | null {
  if (text === undefined) {
    return null;
  }
  const match = MONTH_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const month = { year: Number(match[1]), month: Number(match[2]) };
  return month.month >= 1 && month.month <= 12 ? month : null;
}

/** "YYYY-MM", the form the parameter and an anchor state a month in. */
export function formatCalendarMonth(month: CalendarMonth): string {
  return `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`;
}

/**
 * The month an instant falls in, on the association's own clock.
 *
 * Through the calendar module's own reader rather than through a formatter of
 * this file's, because "which month is it" has to be the same question the
 * occurrences were written against: an event at half past midnight on the first
 * of April is in April, and reading the instant as UTC would put it in March for
 * part of the year.
 */
export function calendarMonthOf(instant: Date): CalendarMonth {
  const day = localDayOf(instant);
  return { year: day.year, month: day.month };
}

/**
 * A month shifted by whole months.
 *
 * Arithmetic on the month number rather than on a date, so shifting away from
 * the 31st cannot land on a day that does not exist: a month has no day in it
 * to lose.
 */
export function shiftCalendarMonth(
  month: CalendarMonth,
  months: number,
): CalendarMonth {
  const zeroBased = month.year * 12 + (month.month - 1) + months;
  return {
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
  };
}

/** Negative, zero or positive as the first month is before, in or after. */
function compareCalendarMonths(
  first: CalendarMonth,
  second: CalendarMonth,
): number {
  return first.year * 12 + first.month - (second.year * 12 + second.month);
}

/**
 * A month pulled into the span the calendar answers for.
 *
 * Clamped rather than refused, because there is nothing here for a visitor to
 * have got wrong: a month outside the span is a month with nothing in it, and a
 * not-found document would say the calendar does not exist rather than that it
 * does not reach that far. A parameter that is not a month at all is a
 * different case and is handled by {@link parseCalendarMonth}, which answers
 * null and leaves the caller on the month it would have shown anyway.
 */
export function clampCalendarMonth(
  month: CalendarMonth,
  now: Date,
): CalendarMonth {
  const current = calendarMonthOf(now);
  const earliest = shiftCalendarMonth(current, -CALENDAR_MONTHS_BACK);
  const latest = shiftCalendarMonth(current, CALENDAR_MONTHS_AHEAD);

  if (compareCalendarMonths(month, earliest) < 0) {
    return earliest;
  }
  return compareCalendarMonths(month, latest) > 0 ? latest : month;
}

/** The two months a reader may reach from this one, or null at either end. */
function neighboursOf(
  month: CalendarMonth,
  now: Date,
): { previous: CalendarMonth | null; next: CalendarMonth | null } {
  const previous = shiftCalendarMonth(month, -1);
  const next = shiftCalendarMonth(month, 1);
  return {
    // A neighbour the clamp would pull back to somewhere else is outside the
    // span, so there is nothing to link to. Asking the clamp rather than
    // comparing against the bounds again is what keeps one answer to where the
    // calendar reaches.
    previous:
      compareCalendarMonths(clampCalendarMonth(previous, now), previous) === 0
        ? previous
        : null,
    next:
      compareCalendarMonths(clampCalendarMonth(next, now), next) === 0
        ? next
        : null,
  };
}

/**
 * The instants a month runs between, the second exclusive.
 *
 * Both derived through the same conversion the occurrences were written with, so
 * a date at half past midnight on the first of April falls in April here as
 * well. Reading a month boundary as UTC instead would put the two hours after
 * local midnight in the month before for part of the year.
 */
function monthWindow(month: CalendarMonth): { from: Date; to: Date } {
  const from = instantAt({ year: month.year, month: month.month, day: 1 }, 0);
  const to = instantAt({ ...shiftCalendarMonth(month, 1), day: 1 }, 0);
  /* c8 ignore next 6 -- unreachable: Sweden's clock has never skipped midnight */
  if (from === null || to === null) {
    throw new Error(
      `No local midnight bounds the month ${formatCalendarMonth(month)}.`,
    );
  }
  return { from, to };
}

/**
 * What one date is read as, and the whole of what the website may know about a
 * sign-up.
 *
 * The places are a filtered relation count and not a list of rows. That is the
 * boundary as a query rather than as a convention: `_count` yields a number, so
 * there is no shape in this select that a person's identifier could travel in
 * however the mapping below is later changed.
 */
const DATE_SELECT = {
  startsAt: true,
  endsAt: true,
  cancelledAt: true,
  event: {
    select: {
      id: true,
      title: true,
      category: true,
      location: true,
      signupOpen: true,
      capacity: true,
    },
  },
  _count: { select: { signups: { where: { withdrawnAt: null } } } },
} as const;

@Injectable()
export class SiteEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The dates still to come, soonest first.
   *
   * What a calendar block on a page shows. A date that has begun and not ended
   * stays on the list: it is today's event, and a reader looking at the page
   * while it runs is entitled to see it rather than to find it already gone.
   *
   * Bounded by the count the block asked for rather than by a horizon, because
   * the count is what the block is for - a page shows the next few dates and
   * the calendar page shows the rest.
   */
  async upcoming(
    hasSession: boolean,
    limit: number,
    now: Date = new Date(),
  ): Promise<SiteEventDate[]> {
    return this.dates(hasSession, { endsAt: { gte: now } }, limit);
  }

  /**
   * One month of the calendar, and where a reader may go from it.
   *
   * Handed the parameter as it arrived rather than a month, so the strict read
   * and the clamp happen once, here, and a second caller cannot arrive at a
   * different answer about which months this calendar reaches. A parameter that
   * is not a month leaves the reader on the current one, which is the month the
   * address /kalender shows.
   *
   * Every date in the month, not only the ones still to come: a month is asked
   * for by name, and answering the current one with its second half alone would
   * make the page disagree with the anchor that reached it.
   */
  async month(
    hasSession: boolean,
    requested: string | undefined,
    now: Date = new Date(),
  ): Promise<SiteCalendarPage> {
    const month = clampCalendarMonth(
      parseCalendarMonth(requested) ?? calendarMonthOf(now),
      now,
    );
    const { from, to } = monthWindow(month);

    return {
      month,
      ...neighboursOf(month, now),
      dates: await this.dates(hasSession, {
        startsAt: { gte: from, lt: to },
      }),
    };
  }

  /**
   * One event by its address, or nothing.
   *
   * Null covers all three of: no such event, an event not published, and an
   * event for the members asked for without a session. One value, so the caller
   * cannot accidentally tell them apart and neither can the visitor - which is
   * what keeps a members-only cleaning day answered exactly as an address that
   * names nothing.
   *
   * Every date in the series, earliest first and called-off ones included. A
   * series holds at most 105 occurrences, which the recurrence rule bounds, so
   * this is a page and not an unbounded read.
   */
  async byId(id: string, hasSession: boolean): Promise<SiteEvent | null> {
    const row = await this.prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        description: true,
        category: true,
        location: true,
        published: true,
        visibility: true,
        occurrences: {
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          select: DATE_SELECT,
        },
      },
    });

    if (row === null || !row.published) {
      return null;
    }
    if (row.visibility === "MEMBER" && !hasSession) {
      return null;
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      location: row.location,
      dates: row.occurrences.map((occurrence) => toDate(occurrence)),
    };
  }

  /**
   * Every date the reader may see inside a window, soonest first.
   *
   * The one read the three answers above are built from, and the one place the
   * audience is decided: published events for everybody, and the members' ones
   * as well for anyone carrying a session. Written once here so a block, a
   * month and an event cannot answer it three different ways.
   *
   * The identifier breaks a tie, so two dates at the same instant come back in
   * one order rather than in whichever the database happened to produce.
   */
  private async dates(
    hasSession: boolean,
    window: { startsAt?: { gte: Date; lt: Date }; endsAt?: { gte: Date } },
    limit?: number,
  ): Promise<SiteEventDate[]> {
    const rows = await this.prisma.eventOccurrence.findMany({
      where: {
        event: {
          published: true,
          ...(hasSession ? {} : { visibility: "PUBLIC" }),
        },
        ...window,
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      ...(limit === undefined ? {} : { take: limit }),
      select: DATE_SELECT,
    });

    return rows.map((row) => toDate(row));
  }
}

/** One stored occurrence, as the website reads it. */
function toDate(row: {
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  event: {
    id: string;
    title: string;
    category: string | null;
    location: string | null;
    signupOpen: boolean;
    capacity: number | null;
  };
  _count: { signups: number };
}): SiteEventDate {
  return {
    eventId: row.event.id,
    title: row.event.title,
    category: row.event.category,
    location: row.event.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    // A date, on the row, and a boolean on the way out: when the board decided
    // to call a date off is the association's own bookkeeping, and the website
    // says that it is off.
    cancelled: row.cancelledAt !== null,
    signupOpen: row.event.signupOpen,
    capacity: row.event.capacity,
    placesTaken: row._count.signups,
  };
}

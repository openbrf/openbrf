import {
  compareLocalDays,
  formatLocalDay,
  type LocalDay,
  localDayOf,
} from "../bookings/stockholm-calendar";

/**
 * The bylaws' deadline for motions to the general meeting, and the date it next
 * falls on.
 *
 * ## Why the bylaws decide it
 *
 * EFL 6 kap. 15 §, which BRL 9 kap. 14 § applies to a housing cooperative
 * unchanged, gives a member the right to have an item taken up at a general
 * meeting if they ask the board in writing in time for the item to go into the
 * notice - and it goes on to say that the request is to be made in the manner
 * and within the time the bylaws determine, where the bylaws say anything about
 * it. So the deadline is the association's own clause. There is no default here
 * and there must not be: a number invented by the platform would be the platform
 * asserting a term of a document it has not read, and a member turned away by it
 * would be turned away for a rule the association never adopted.
 *
 * A cooperative whose bylaws are silent has no deadline, which is
 * {@link MotionDeadline} being null. Intake stays open and the board decides
 * what it can still get into the notice, which is what the first sentence of the
 * paragraph leaves to it anyway.
 *
 * ## Why a month and a day
 *
 * A bylaws clause is a standing rule: "motions must reach the board by 31
 * January" is true every year. An absolute date would be right for one season
 * and silently wrong for every one after it, and it would go wrong in the one
 * month of the year anybody looks - which is the worst possible time for a
 * setting to be quietly stale. A number of days before the meeting is the other
 * shape such a clause takes, and it is not available: no meeting exists in this
 * data model yet, so a window measured backwards from one would be a setting
 * nothing could evaluate.
 *
 * ## What this does not do
 *
 * It does not refuse a late motion, and nothing in this module does. The
 * deadline is the condition on the member's *right to have the item taken up at
 * a particular meeting*, not a condition on the association's ability to receive
 * one: a motion arriving the day after is not void, it is a motion the board may
 * still take up and otherwise an item for the next meeting. Refusing it would
 * throw away something the association is free to accept. So the deadline is
 * stated - on the member's form and on the board's queue - and the board
 * triages, which is the division of labour the statute already describes.
 */

/** The deadline as the bylaws state it: a recurring month and day. */
export interface MotionDeadline {
  /** 1 to 12, as written. */
  month: number;
  /** 1 to 31, as the clause writes it. See {@link nextMotionDeadline}. */
  day: number;
}

/** The deadline as a payload states it, with the date it next falls on. */
export interface MotionDeadlineView extends MotionDeadline {
  /** "YYYY-MM-DD": the next occurrence, today included. */
  nextOn: string;
}

/** Whether these two columns are a deadline, i.e. whether both are set. */
export function readMotionDeadline(row: {
  motionDeadlineMonth: number | null;
  motionDeadlineDay: number | null;
}): MotionDeadline | null {
  const { motionDeadlineMonth: month, motionDeadlineDay: day } = row;
  if (month === null || day === null) {
    // Half a deadline is no deadline. The settings write refuses one column
    // without the other, so reaching this with one set means the row predates
    // that rule or was written by hand, and answering "no deadline" is the
    // reading that cannot turn a member away for a rule nobody can see.
    return null;
  }
  return { month, day };
}

/**
 * How many days a month has, in a given year.
 *
 * Through `Date.UTC`, which is the proleptic Gregorian calendar and carries no
 * zone, so the leap-year rule comes from the platform rather than from a table
 * here. Day 0 of the next month is the last day of this one - the same trick
 * `personal-identity-number.ts` uses, for the same reason.
 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The next date the deadline falls on, today included.
 *
 * Today included because a deadline is a day and not an instant: a member
 * looking at the form on the 31st of January is looking at it on the last day,
 * and telling them the deadline is next year would be wrong by a year on the one
 * day it matters most.
 *
 * The day is clamped to the length of the month in the year it resolves to, so a
 * clause naming 29 February falls on the 28th in a year that has no 29th. Taken
 * as the clause writes it rather than normalised at write time, because what the
 * bylaws say is what the setting records: a clause reading "29 February" is not
 * a clause reading "28 February", and it should read back as the former in the
 * three years out of four when it happens to resolve to the latter.
 *
 * @param now The moment to resolve from. The Stockholm calendar date it falls on
 *   is what decides whether this year's deadline has passed, because the
 *   association's year is the Swedish one and an hour either side of UTC midnight
 *   would otherwise move the answer by a day.
 */
export function nextMotionDeadline(
  deadline: MotionDeadline,
  now: Date = new Date(),
): LocalDay {
  const today = localDayOf(now);

  const occurrence = (year: number): LocalDay => ({
    year,
    month: deadline.month,
    day: Math.min(deadline.day, daysInMonth(year, deadline.month)),
  });

  const thisYear = occurrence(today.year);
  return compareLocalDays(thisYear, today) >= 0
    ? thisYear
    : occurrence(today.year + 1);
}

/** The deadline as a payload carries it, or null when the bylaws state none. */
export function motionDeadlineView(
  deadline: MotionDeadline | null,
  now: Date = new Date(),
): MotionDeadlineView | null {
  if (deadline === null) {
    return null;
  }
  return {
    month: deadline.month,
    day: deadline.day,
    nextOn: formatLocalDay(nextMotionDeadline(deadline, now)),
  };
}

/**
 * Whether a month and day are a date somebody could have written in a bylaws
 * clause.
 *
 * The month bounds the day rather than a flat 1-to-31, so "31 February" is
 * refused: it is not a date in any year, so a clause could not say it and a
 * board typing it has made a mistake worth being told about. February takes 29,
 * which is a date in a leap year and is what the clamp above exists for.
 */
export function isWritableDeadline(month: number, day: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return false;
  }
  // A leap year, so February admits its 29th.
  return Number.isInteger(day) && day >= 1 && day <= daysInMonth(2024, month);
}

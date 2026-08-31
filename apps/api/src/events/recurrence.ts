/**
 * The recurrence rule, and the dates a series of events falls on.
 *
 * A series is stated the way a notice in the stairwell states it: a first date,
 * a time of day, how long it runs, and how often it comes round. This file
 * turns those into the list of periods the calendar holds, and it is the only
 * place that decides what "the 31st of every month" means in February.
 *
 * ## Every time comes from the wall clock
 *
 * `instantAt` is the only way a local time becomes an instant here, so a
 * cleaning day at ten in the morning is at ten in the morning in every
 * occurrence - including the two Sundays a year that are 23 and 25 hours long,
 * where the instant it names differs by an hour from the Sundays either side.
 * Nothing in this file adds hours to a `Date`: the dates are stepped as
 * calendar dates and converted afterwards, which is the whole of the daylight
 * saving handling.
 *
 * ## Clamping, and why it is never cumulative
 *
 * A MONTHLY series on the 31st and an ANNUAL one on the 29th of February name
 * dates that do not exist in most months and most years. The rule is to clamp
 * to the last day of the target month, which is what a board reading "the 31st
 * of every month" expects: January the 31st, February the 28th, March the 31st.
 *
 * The clamp is applied to a date computed from the FIRST occurrence every time,
 * never to the occurrence before it. Stepping month by month from what the
 * previous step produced would clamp the clamp: February's 28th would become
 * March's 28th, and a series that touched February once would spend the rest of
 * its life four days early. {@link dayOfStep} takes the step number for exactly
 * this reason - there is no state to carry forward, so there is nothing to
 * corrupt.
 *
 * ## What is bounded, and why
 *
 * The occurrences are rows, written when the series is saved, and nothing
 * extends them afterwards. So a rule has to end, and it has to end inside a
 * horizon: {@link RECURRENCE_HORIZON_DAYS} past the first occurrence. A rule
 * reaching further is refused rather than truncated, because a series that
 * silently stopped two years out would be a calendar with a cliff in it that no
 * screen could explain.
 */

import type { EventRecurrenceFrequency } from "../generated/prisma/enums";
import {
  addLocalDays,
  compareLocalDays,
  instantAt,
  type LocalDay,
  type Period,
} from "../bookings/stockholm-calendar";

/**
 * How far past the first occurrence a series may reach.
 *
 * Two years, counted in days and rounded up so that a leap year inside the
 * window does not shorten it: 731 days is exactly two years from a date whose
 * window contains a 29th of February and one day more than two years from one
 * that does not. Counting 730 would let an annual series hold three dates in
 * some years and two in others, which is an asymmetry no board could predict.
 *
 * Two years because the occurrences are rows: they cost storage, every calendar
 * query reads them, and a board that wants a fourth year of sauna evenings will
 * still be here in two years to say so. It is also the point past which a
 * materialised calendar stops describing anything - a date five years out is a
 * plan, and the association's own arrangements will have changed by then.
 *
 * A validation rule and not a generation rule: {@link checkRecurrenceSchedule}
 * refuses a rule that reaches past it, so nothing is ever truncated. A series
 * that silently stopped two years out would be a calendar with a cliff in it
 * that no screen could explain.
 */
export const RECURRENCE_HORIZON_DAYS = 731;

/**
 * The most occurrences one series may hold.
 *
 * Derived from the horizon rather than chosen: the densest rule this module
 * offers is weekly with an interval of one, and the horizon holds 105 of those -
 * days 0 through 728. So no rule that passes {@link checkRecurrenceSchedule} can
 * reach this, and it is the generator's own hard stop rather than a second rule
 * about what a board may ask for: a belt against a row edited into an impossible
 * state by hand, which would otherwise be an unbounded loop.
 */
export const MAX_OCCURRENCES = 105;

/** The most minutes an event may run for: one whole day. */
export const MAX_DURATION_MINUTES = 24 * 60;

/** How often a series comes round, and when it stops. */
export interface RecurrenceRule {
  frequency: EventRecurrenceFrequency;
  /** Every how many weeks, months or years. At least one. */
  interval: number;
  /**
   * How many occurrences in total, the first included, or null when the rule
   * ends on a date instead. Exactly one of the two is set.
   */
  count: number | null;
  /** The last date an occurrence may fall on, or null when it ends on a count. */
  until: LocalDay | null;
}

/** A series as this file reads it: when it starts, how long, how often. */
export interface SeriesSchedule {
  firstOn: LocalDay;
  /** Minutes past local midnight, so 600 is 10:00. */
  startsAtMinute: number;
  /** Wall-clock minutes. See Event.durationMinutes. */
  durationMinutes: number;
  /** The rule, or null for a single event. */
  recurrence: RecurrenceRule | null;
}

/** What is wrong with a schedule, as a refusal code. */
export type RecurrenceProblem =
  | "recurrence-interval-invalid"
  | "recurrence-end-required"
  | "recurrence-end-ambiguous"
  | "recurrence-end-invalid"
  | "recurrence-past-horizon"
  | "duration-invalid"
  | "start-does-not-exist";

/**
 * What is wrong with a series' schedule, or null when nothing is.
 *
 * Every rule about the schedule in one place, so the service asks once and the
 * endpoint's own schema is left to bound what a request may carry. The order
 * matters only in that a more specific complaint comes first: a board that sent
 * both a count and an until date is told that, rather than being told the count
 * is too large.
 */
export function checkRecurrenceSchedule(
  schedule: SeriesSchedule,
): RecurrenceProblem | null {
  if (
    !Number.isInteger(schedule.durationMinutes) ||
    schedule.durationMinutes < 1 ||
    schedule.durationMinutes > MAX_DURATION_MINUTES
  ) {
    return "duration-invalid";
  }

  /*
   * The first occurrence has to exist, both ends of it.
   *
   * Refused rather than skipped, which is the opposite of what happens to a
   * later occurrence on the same local time - see {@link occurrencePeriods}.
   * The difference is who is being answered: a board typing 02:30 on the last
   * Sunday in March has asked for a moment the wall clock never reads, and the
   * honest answer is to say so while they are still on the form. A series whose
   * fifty-second week happens to land there is a rule that was right when it
   * was written, and dropping that one week is less wrong than moving it.
   */
  if (
    instantAt(schedule.firstOn, schedule.startsAtMinute) === null ||
    instantAt(
      schedule.firstOn,
      schedule.startsAtMinute + schedule.durationMinutes,
    ) === null
  ) {
    return "start-does-not-exist";
  }

  const rule = schedule.recurrence;
  if (rule === null) {
    return null;
  }

  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    return "recurrence-interval-invalid";
  }

  if (rule.count === null && rule.until === null) {
    return "recurrence-end-required";
  }
  if (rule.count !== null && rule.until !== null) {
    return "recurrence-end-ambiguous";
  }

  const horizon = addLocalDays(schedule.firstOn, RECURRENCE_HORIZON_DAYS);

  if (rule.count !== null) {
    if (!Number.isInteger(rule.count) || rule.count < 2) {
      // A recurring series with one occurrence is not recurring. The board is
      // told to drop the rule rather than being handed a series whose rule
      // describes something it does not do.
      return "recurrence-end-invalid";
    }
    const last = dayOfStep(schedule.firstOn, rule, rule.count - 1);
    return compareLocalDays(last, horizon) > 0
      ? "recurrence-past-horizon"
      : null;
  }

  if (rule.until === null) {
    /* c8 ignore next 2 -- unreachable: one of count and until is set above */
    return null;
  }
  if (compareLocalDays(rule.until, schedule.firstOn) < 0) {
    return "recurrence-end-invalid";
  }
  if (compareLocalDays(dayOfStep(schedule.firstOn, rule, 1), rule.until) > 0) {
    // The rule ends before it comes round even once, so it names one date and
    // describes a repetition that never happens. Same refusal as a count of
    // one, and the same fix: drop the rule.
    return "recurrence-end-invalid";
  }
  return compareLocalDays(rule.until, horizon) > 0
    ? "recurrence-past-horizon"
    : null;
}

/**
 * The local dates a schedule names, in order, the first included.
 *
 * A schedule with no rule names exactly one date. That is the whole of the
 * single-event case: there is no branch for it anywhere above this line.
 *
 * What the rule says, and nothing about whether the rule was allowed. The
 * horizon is checked by {@link checkRecurrenceSchedule} and is deliberately not
 * applied here: a generator that truncated would answer differently from the
 * rule it was given, and the one place that decides what a board may ask for
 * would then be two. {@link MAX_OCCURRENCES} still stops it, which is the belt
 * against a row edited into an impossible state by hand.
 */
export function recurrenceDays(schedule: SeriesSchedule): LocalDay[] {
  const rule = schedule.recurrence;
  if (rule === null) {
    return [schedule.firstOn];
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    /* c8 ignore next 5 -- unreachable through the service, which refuses it */
    return [schedule.firstOn];
  }

  const days: LocalDay[] = [];

  for (let step = 0; step < MAX_OCCURRENCES; step += 1) {
    if (rule.count !== null && step >= rule.count) {
      break;
    }
    const day = dayOfStep(schedule.firstOn, rule, step);
    if (rule.until !== null && compareLocalDays(day, rule.until) > 0) {
      break;
    }
    days.push(day);
  }

  return days;
}

/**
 * The periods a schedule names, as instants, in order.
 *
 * Each date is converted through `instantAt`, so the period is the wall-clock
 * time on that date rather than a fixed number of hours after the one before
 * it: a weekly ten o'clock event is at ten o'clock on both sides of both
 * daylight saving changes, and the instants either side of a change are an hour
 * apart from what a naive seven-day addition would have given.
 *
 * A date whose local start or end the clocks jumped over is left out rather
 * than moved. That is the one hour a year - 02:00 to 02:59 on the last Sunday
 * in March - where the wall clock does not read what the series says, so there
 * is no instant to answer with, and inventing one would put the occurrence an
 * hour from where the board asked for it. The first occurrence is refused
 * instead of dropped; see {@link checkRecurrenceSchedule}.
 */
export function occurrencePeriods(schedule: SeriesSchedule): Period[] {
  const periods: Period[] = [];

  for (const day of recurrenceDays(schedule)) {
    const startsAt = instantAt(day, schedule.startsAtMinute);
    const endsAt = instantAt(
      day,
      schedule.startsAtMinute + schedule.durationMinutes,
    );
    if (startsAt !== null && endsAt !== null) {
      periods.push({ startsAt, endsAt });
    }
  }

  return periods;
}

/**
 * The date the nth occurrence falls on, counting the first as step zero.
 *
 * Computed from `first` and never from the step before it, which is what makes
 * the month-end clamp non-cumulative. See the file comment.
 */
function dayOfStep(
  first: LocalDay,
  rule: RecurrenceRule,
  step: number,
): LocalDay {
  switch (rule.frequency) {
    case "WEEKLY":
      return addLocalDays(first, step * rule.interval * 7);
    case "MONTHLY":
      return addLocalMonths(first, step * rule.interval);
    case "ANNUAL":
      return addLocalMonths(first, step * rule.interval * 12);
  }
}

/**
 * A calendar date shifted by whole months, clamped to the end of the month.
 *
 * Here rather than beside `addLocalDays` in `stockholm-calendar.ts`, and
 * deliberately. Adding a day to the 28th of October has exactly one answer;
 * adding a month to the 31st of January has three defensible ones - the 28th of
 * February, the 3rd of March, or no date at all - and choosing between them is
 * this module's policy about what a recurring event means rather than a neutral
 * fact about the Swedish calendar.
 *
 * The month arithmetic goes through `Date.UTC`, which is the proleptic
 * Gregorian calendar and carries no zone at all, so month lengths and the
 * leap-year rule come from the platform rather than from a table here.
 */
function addLocalMonths(day: LocalDay, months: number): LocalDay {
  const monthsFromYearZero = day.month - 1 + months;
  const year = day.year + Math.floor(monthsFromYearZero / 12);
  const month = (((monthsFromYearZero % 12) + 12) % 12) + 1;
  return { year, month, day: Math.min(day.day, daysInMonth(year, month)) };
}

/** Days in a month, honouring the Gregorian leap-year rule. */
function daysInMonth(year: number, month: number): number {
  // Day zero of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

import {
  instantAt,
  type LocalDay,
  localDayOf,
  localMinuteOf,
  MINUTES_PER_DAY,
} from "@openbrf/shared";

import {
  type AssociationFactsView,
  recordsAFact,
} from "./association-facts.service";

/**
 * How long the association's facts count as current, and whether a broker may
 * ask for them to be looked at again.
 *
 * One rule, read by two callers that must never disagree: the broker page,
 * which offers "Request updates" only once the facts have gone stale, and the
 * endpoint that takes the request, which asks the same question again rather
 * than trusting that the page it was sent from was current. A page cached
 * from yesterday, or a form posted by hand, would otherwise reach the board's
 * queue on the day the board confirmed its facts.
 *
 * The threshold is the board's own setting, in whole months, and is read at
 * the moment of asking. Nothing is computed ahead and stored, so a board that
 * shortens it from six months to three makes the action appear that moment,
 * and one that lengthens it takes it away again, with nothing to recompute.
 *
 * Calendar months on the association's wall clock, to the instant: facts
 * confirmed at 10:00 on 19 October with a threshold of three months are
 * current until 10:00 on 19 January, and stale from any moment after it. The
 * time of day is the wall clock's and not a count of hours, so a threshold
 * that spans the change to or from summer time still ends at 10:00. A day the
 * target month does not have falls on that month's last day, so 31 January
 * plus one month ends on 28 February, or the 29th in a leap year, at the time
 * of day of the confirmation.
 *
 * Facts that have never been confirmed have nothing to be current from, and
 * count as stale: a board that recorded its facts before confirmations were
 * dated, or has never confirmed them since, is asked about them exactly as one
 * whose confirmation has run out.
 */

/**
 * The moment the facts stop being current: the instant they were confirmed,
 * the board's number of calendar months on, on the association's wall clock.
 */
export function factsCurrentUntil(
  confirmedAt: Date,
  staleAfterMonths: number,
): Date {
  const day = addLocalMonths(localDayOf(confirmedAt), staleAfterMonths);
  const minute = localMinuteOf(confirmedAt);
  // The seconds and milliseconds within the minute. Every offset the
  // association's clock has had is a whole number of minutes, so they are the
  // same on the wall clock as in UTC.
  const withinMinute =
    ((confirmedAt.getTime() % MILLISECONDS_PER_MINUTE) +
      MILLISECONDS_PER_MINUTE) %
    MILLISECONDS_PER_MINUTE;

  const exact = instantAt(day, minute);
  if (exact !== null) {
    return new Date(exact.getTime() + withinMinute);
  }
  return firstInstantFrom(day, minute);
}

/**
 * Whether facts confirmed then are stale now.
 *
 * Not stale at the moment they stop being current, stale at any moment after
 * it, so "older than three months" means older and not "three months old".
 */
export function isFactsStale(
  confirmedAt: Date,
  staleAfterMonths: number,
  now: Date,
): boolean {
  return (
    now.getTime() > factsCurrentUntil(confirmedAt, staleAfterMonths).getTime()
  );
}

/**
 * Whether the broker page offers "Request updates" now, and whether the
 * endpoint takes one.
 *
 * Only over facts there are: at least one fact recorded. An association that
 * has recorded nothing has no facts on its page for a broker to call out of
 * date, and a form there would put requests in the queue of a board that has
 * never used the feature. Recorded facts that have never been confirmed are
 * stale, as the module comment says.
 */
export function updatesRequestable(
  facts: AssociationFactsView,
  now: Date,
): boolean {
  if (!recordsAFact(facts)) {
    return false;
  }
  return (
    facts.confirmedAt === null ||
    isFactsStale(new Date(facts.confirmedAt), facts.staleAfterMonths, now)
  );
}

const MILLISECONDS_PER_MINUTE = 60 * 1000;

/**
 * A calendar date the given number of months on, held to the target month's
 * last day.
 *
 * Done through `Date.UTC`, which carries no zone, as the shared calendar's own
 * day arithmetic is: day 0 of the month after the target is the target's last
 * day, whatever its length.
 */
function addLocalMonths(day: LocalDay, months: number): LocalDay {
  const target = new Date(Date.UTC(day.year, day.month - 1 + months, 1));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(day.day, lastDay) };
}

/**
 * The first instant the wall clock reads this time of day or later, for a
 * time it skips.
 *
 * Only the March Sunday's hour between 02:00 and 03:00 is skipped, so this is
 * the moment the clocks go forward: the wall clock has passed the time of the
 * confirmation then, and the facts are current until that moment and no
 * longer.
 */
function firstInstantFrom(day: LocalDay, minute: number): Date {
  for (let next = minute + 1; next <= minute + MINUTES_PER_DAY; next += 1) {
    const at = instantAt(day, next);
    if (at !== null) {
      return at;
    }
  }
  /* c8 ignore next 3 -- unreachable: the clock never skips a whole day */
  throw new Error("The association's clock skips a whole day.");
}

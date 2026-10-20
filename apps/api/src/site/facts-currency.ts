import { compareLocalDays, type LocalDay, localDayOf } from "@openbrf/shared";

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
 * shortens it from six months to three makes the action appear that day, and
 * one that lengthens it takes it away again, with nothing to recompute.
 *
 * Calendar months on the association's calendar, and whole days: the page
 * prints the day the board confirmed, so the broker reading it counts from that
 * day too. Facts confirmed on 19 October with a threshold of three months are
 * current through 19 January, and stale from 20 January. A day the target
 * month does not have falls on that month's last day, so 31 January plus one
 * month is current through 28 February, or the 29th in a leap year.
 */

/**
 * The last day the facts count as current: the day they were confirmed, the
 * board's number of calendar months on.
 */
export function factsCurrentThrough(
  confirmedAt: Date,
  staleAfterMonths: number,
): LocalDay {
  return addLocalMonths(localDayOf(confirmedAt), staleAfterMonths);
}

/**
 * Whether facts confirmed then are stale now.
 *
 * Not stale on the last day they are current, stale from the day after, so
 * "older than three months" means older and not "three months old".
 */
export function isFactsStale(
  confirmedAt: Date,
  staleAfterMonths: number,
  now: Date,
): boolean {
  return (
    compareLocalDays(
      localDayOf(now),
      factsCurrentThrough(confirmedAt, staleAfterMonths),
    ) > 0
  );
}

/**
 * Whether the broker page offers "Request updates" now, and whether the
 * endpoint takes one.
 *
 * Only over facts the page prints a date for: at least one fact recorded, and
 * a confirmation to count from. An association that has recorded nothing has
 * no date on its page and nothing for a broker to call out of date, and a form
 * on that page would put requests in the queue of a board that has never used
 * the feature - which would be a change to the page every association has had
 * since it shipped.
 */
export function updatesRequestable(
  facts: AssociationFactsView,
  now: Date,
): boolean {
  return (
    facts.confirmedAt !== null &&
    recordsAFact(facts) &&
    isFactsStale(new Date(facts.confirmedAt), facts.staleAfterMonths, now)
  );
}

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

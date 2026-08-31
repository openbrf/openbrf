/**
 * What an edit to a series does to the dates it already has.
 *
 * Editing a series is not writing its occurrences again. The rows already there
 * have identities that other rows point at - a sign-up is a row naming one
 * occurrence - so an edit has to say, date by date, which rows stay as they are,
 * which move, which go and which arrive. That is what this file computes, and it
 * computes it without touching a database so that the rule can be tested
 * against a calendar rather than against the generator that produced it.
 *
 * ## Occurrences are matched by their local date
 *
 * The cleaning day on the 18th of April is the same cleaning day whether it
 * starts at nine or at ten, so an edit that moves the time keeps the row - and
 * with it the sign-ups pointing at it and the board's decision to call that one
 * off. Matching by instant instead would make every time change a wholesale
 * replacement, and a series whose start moved by fifteen minutes would drop
 * every sign-up it had.
 *
 * The match is unambiguous because no rule this module offers can name one date
 * twice: every step is at least a week, and the month and year steps are
 * computed from the first date rather than from each other.
 *
 * ## What has already started is never touched
 *
 * An occurrence that has begun is the record of what was arranged, on the
 * argument the booking module makes about its own past bookings: rewriting the
 * slots does not make last March untrue. So the dates of those rows are frozen
 * - they stay exactly as they are, and a period the new rule names on one of
 * those dates is not written beside them. A series whose time the board moved in
 * June therefore has spring occurrences at the old time and autumn ones at the
 * new, which is what actually happened.
 *
 * A series being created has no rows at all, so nothing is frozen and every
 * period the rule names is written, whether it has passed or not. That is the
 * same rule and not an exception to it: what is protected is a row that exists,
 * and a board entering a series that started last month is stating history
 * rather than rewriting it.
 */

import {
  formatLocalDay,
  localDayOf,
  type Period,
} from "../bookings/stockholm-calendar";

/** An occurrence as it stands in the table. */
export interface StoredOccurrence {
  id: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
}

/** An occurrence whose instants an edit changes, and what it changes them to. */
export interface MovedOccurrence {
  occurrence: StoredOccurrence;
  period: Period;
}

/** What an edit does to the occurrences a series already has. */
export interface OccurrencePlan {
  /**
   * Rows the edit leaves alone: the ones that have started, and the future ones
   * the new rule names at exactly the same instants.
   */
  kept: StoredOccurrence[];
  /** Rows that keep their id and their cancellation, at new instants. */
  moved: MovedOccurrence[];
  /** Rows the new rule does not name. */
  dropped: StoredOccurrence[];
  /** Periods the new rule names that no row covers. */
  added: Period[];
}

/**
 * The occurrences an edit displaces: the ones it moves and the ones it drops.
 *
 * The set the write path checks for sign-ups before it commits to anything. A
 * kept row is not displaced however much else about the series changed - a new
 * title, a new location, sign-up opened - which is why renaming a series is
 * never refused.
 */
export function displacedBy(plan: OccurrencePlan): StoredOccurrence[] {
  return [...plan.moved.map((entry) => entry.occurrence), ...plan.dropped];
}

/**
 * What to do with each existing occurrence, and what to add.
 *
 * @param existing The rows the series has now, in any order.
 * @param planned The periods the new schedule names, in order.
 * @param now The instant "has this started" is judged against. Injected so a
 *   test states its own clock rather than depending on when it is run.
 */
export function planOccurrences(
  existing: readonly StoredOccurrence[],
  planned: readonly Period[],
  now: Date,
): OccurrencePlan {
  const plan: OccurrencePlan = { kept: [], moved: [], dropped: [], added: [] };

  /*
   * The dates that are already history, and the future rows by date.
   *
   * Two passes rather than one, because a planned period has to know whether
   * its date is frozen before it can be matched, and the rows arrive in no
   * particular order.
   */
  const frozenDays = new Set<string>();
  const futureByDay = new Map<string, StoredOccurrence>();

  for (const occurrence of existing) {
    const key = dayKey(occurrence.startsAt);
    if (occurrence.startsAt.getTime() <= now.getTime()) {
      frozenDays.add(key);
      plan.kept.push(occurrence);
    } else {
      futureByDay.set(key, occurrence);
    }
  }

  for (const period of planned) {
    const key = dayKey(period.startsAt);
    if (frozenDays.has(key)) {
      // The row on that date has started. It stands as it was, and the period
      // the new rule names there is not written beside it.
      continue;
    }

    const standing = futureByDay.get(key);
    if (standing === undefined) {
      plan.added.push(period);
      continue;
    }

    futureByDay.delete(key);
    if (
      standing.startsAt.getTime() === period.startsAt.getTime() &&
      standing.endsAt.getTime() === period.endsAt.getTime()
    ) {
      plan.kept.push(standing);
    } else {
      plan.moved.push({ occurrence: standing, period });
    }
  }

  // Whatever is left had a date the new rule does not name.
  plan.dropped.push(...futureByDay.values());

  return plan;
}

/** The local calendar date an instant falls on, as a comparable key. */
function dayKey(instant: Date): string {
  return formatLocalDay(localDayOf(instant));
}

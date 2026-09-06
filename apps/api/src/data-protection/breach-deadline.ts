/**
 * The clock GDPR art. 33(1) puts on a personal data breach
 * (personuppgiftsincident), and the state the register shows a board.
 *
 * Art. 33(1) has the controller notify the supervisory authority "without undue
 * delay and, where feasible, not later than 72 hours after having become aware
 * of it". Three things in that sentence shape everything here:
 *
 *   - the clock starts at awareness, not at the moment somebody found time to
 *     write the breach down, which is why every function below is anchored on
 *     discoveredAt and never on createdAt;
 *   - 72 hours is a bound on a duty that is already "without undue delay", so
 *     what is derived here is called the bound and never "the deadline". A
 *     board that waits 71 hours for no reason has not complied by being inside
 *     it;
 *   - passing it is not a failure state that ends the duty. A late notification
 *     is still made, and art. 33(1) has it carry the reasons for the delay,
 *     which is why the overdue state below stays actionable rather than final.
 *
 * The bound, the reminder instant and the state are all **derived, never
 * stored**, the rule `retention/purge-date.ts` sets out: a stored bound would
 * be wrong the moment a board corrected a discovery date, and wrong silently.
 *
 * Millisecond arithmetic on the UTC instant throughout, never calendar fields.
 * Adding 72 hours in Europe/Stockholm shifts the result by an hour across a
 * daylight saving boundary, and an hour is a real amount of a three-day
 * statutory window.
 */

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/**
 * The bound art. 33(1) sets, in hours from the association becoming aware.
 *
 * A constant and not a setting: it is the regulation's number, and an
 * association that could shorten or lengthen it would be recording something
 * other than what the article requires.
 */
export const BREACH_NOTIFICATION_HOURS = 72;

/**
 * How long before the bound the board is reminded.
 *
 * A day, which is what leaves a working day to act in: a breach found on a
 * Friday evening reaches its bound on Monday evening, and a reminder 24 hours
 * ahead lands while somebody can still do something about it. Earlier would
 * arrive before the board has finished establishing the facts; later would be
 * a notification that the time has gone rather than a reminder.
 */
export const BREACH_REMINDER_HOURS_LEFT = 24;

/** What the state functions need of a breach row; anything wider is ignored. */
export interface BreachClock {
  discoveredAt: Date;
  decidedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Where the 72 hours of art. 33(1) run out for a breach discovered at a given
 * moment.
 */
export function computeBreachDeadline(discoveredAt: Date): Date {
  return new Date(
    discoveredAt.getTime() + BREACH_NOTIFICATION_HOURS * MILLISECONDS_PER_HOUR,
  );
}

/**
 * When the board is reminded that the bound is approaching.
 *
 * Derived from the bound rather than from the discovery, so the two can never
 * drift: the reminder is always exactly {@link BREACH_REMINDER_HOURS_LEFT}
 * hours of remaining time, whatever either constant becomes.
 *
 * The instant may be in the past, for a breach recorded late or discovered days
 * ago. That is not an error and is not corrected here: the job queue runs a
 * past instant at once, which is the right answer for a board that is already
 * out of time.
 */
export function computeBreachReminderAt(discoveredAt: Date): Date {
  return new Date(
    computeBreachDeadline(discoveredAt).getTime() -
      BREACH_REMINDER_HOURS_LEFT * MILLISECONDS_PER_HOUR,
  );
}

/**
 * How many hours are left before the bound. Negative once it has passed, which
 * is what the screen states rather than hiding behind a single word.
 *
 * Not rounded: the caller decides how to say it, and rounding here would make
 * a breach with four minutes left read as though it had none.
 */
export function hoursLeft(discoveredAt: Date, now: Date): number {
  return (
    (computeBreachDeadline(discoveredAt).getTime() - now.getTime()) /
    MILLISECONDS_PER_HOUR
  );
}

/**
 * What the register shows about one breach.
 *
 * Four states rather than more, and the order they are tested in matters:
 *
 *   - `closed`: the association has nothing left to do. Closing requires a
 *     decision, so this is always downstream of `decided`.
 *   - `decided`: the board has answered both questions art. 33 and art. 34 ask.
 *     A decided breach has no clock left to run, which is why the bound stops
 *     mattering here even if the notification itself was late - the lateness is
 *     recorded on the row as the reasons for the delay.
 *   - `overdue`: undecided and past the bound. Still actionable: art. 33(1)
 *     requires the notification anyway, with its reasons.
 *   - `awaitingDecision`: undecided and inside the bound.
 */
export function breachState(
  row: BreachClock,
  now: Date,
): "awaitingDecision" | "overdue" | "decided" | "closed" {
  if (row.closedAt !== null) {
    return "closed";
  }
  if (row.decidedAt !== null) {
    return "decided";
  }
  return hoursLeft(row.discoveredAt, now) < 0 ? "overdue" : "awaitingDecision";
}

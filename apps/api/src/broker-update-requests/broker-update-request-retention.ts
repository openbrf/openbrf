/**
 * How long a broker's update request is kept, and when the purge reaches it.
 *
 * A request is a stranger's address, and perhaps their name, their firm and
 * an apartment, given for one purpose: so the board can tell them the facts on
 * the broker information page are current again. The windows are the ones the
 * data protection note proposes (docs/broker-package-data-protection.md,
 * "Request updates"), and two clocks run at once.
 *
 * Answered, the purpose ends with the answer. The board's confirmation is what
 * answers the request, and the instance tells the broker nothing; the board
 * reaches them itself. Thirty days covers that and a follow-up question.
 *
 * Whatever happens, ninety days after it arrived. That is one default
 * threshold: a request the board has not answered in that time is better asked
 * again, by a broker whose sale is still open, than kept for one whose sale has
 * closed. An answered request older than that goes too.
 *
 * A request the board dismisses is deleted at once, on the board's screen, and
 * has no clock here: a request somebody has decided is not one has no purpose
 * left to be held for.
 *
 * Constants rather than settings, for the reason `KEY_ORDER_RETENTION_DAYS` is
 * one: the association's retention policy answers how long a former resident's
 * data is kept, and this purpose ends on its own schedule. The cutoffs are
 * derived and never stored, so a shorter window chosen later moves every
 * pending purge with no migration.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** How long an answered request is kept after the confirmation that answered it. */
export const ANSWERED_RETENTION_DAYS = 30;

/** How long any request is kept after it arrived, answered or not. */
export const RECEIVED_RETENTION_DAYS = 90;

/** Answered at or before this instant, a request is past its retention. */
export function answeredPurgeCutoff(
  now: Date,
  retentionDays: number = ANSWERED_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * MILLISECONDS_PER_DAY);
}

/** Received at or before this instant, a request is past it whatever else. */
export function receivedPurgeCutoff(
  now: Date,
  retentionDays: number = RECEIVED_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * MILLISECONDS_PER_DAY);
}

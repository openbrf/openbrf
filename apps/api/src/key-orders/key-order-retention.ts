/**
 * How long a closed key order is kept, and when the purge reaches it.
 *
 * A key order is service-tier personal data: it says that a named resident asked
 * the association for a key or a tag to a named apartment, and that somebody
 * handed it over on a day. The purpose it is held for is running the queue the
 * board works from and answering the resident who asks what became of their
 * order, and that purpose ends a while after the order is closed - so the clock
 * is anchored on the closing date, the way a motion's is, and not on a move-out.
 * Somebody who still lives here has no more use for an order handed over two
 * years ago than somebody who has left, and the residency purge would never
 * reach it at all while they stayed.
 *
 * ## What this is not a register of
 *
 * Who currently holds which key. That would be a standing record of the
 * building's own security kept against named residents, on a clock that never
 * runs out, and nobody has asked for one - so the table records the order and
 * the handover, and the association's answer to "who has a key" is a different
 * record this platform does not keep. It matters for the window below: the row
 * is evidence of a transaction, not an inventory.
 *
 * ## An open order is never purged
 *
 * There is no cutoff for an order still with the board, deliberately, on the
 * reading `motion-retention.ts` sets out: the association is processing it, so
 * the purpose it is held for has not ended, and GDPR art. 5.1 e asks for no
 * longer than necessary *for the purpose* rather than for a fixed span. An open
 * order older than the window is a queue nobody has worked, which is a thing for
 * the board to see rather than for a job to erase.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends, exactly as `bookings/booking-retention.ts` is.
 * {@link computeKeyOrderPurgeDate} answers "when is this order erased", which is
 * a computation per row and what a data subject access report states.
 * {@link keyOrderPurgeCutoff} asks the opposite question of the whole table at
 * once - "which orders closed long enough ago" - which has to be one comparison
 * in SQL. If the two disagree the product erases on a day other than the one it
 * stated, so `key-order-retention.spec.ts` runs them against each other rather
 * than trusting the arithmetic to look symmetrical.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a closed key order is kept.
 *
 * One year, and shorter than the two a motion or a subletting application gets,
 * because the question this row answers has a shorter life than either. A motion
 * is asked about at the general meeting after the one that dealt with it; a
 * consent to let is what a forfeiture dispute turns on after the letting ends.
 * An order for a key is settled when the key is in somebody's hand, and what
 * remains is the association's own accounting year - the cost of the key is a
 * charge (debitering) recorded elsewhere and reconciled with whoever keeps the
 * books, and a year clears that cycle with room for a late reconciliation.
 *
 * A constant rather than a board setting, for the reason
 * `BOOKING_RETENTION_DAYS` is one: the association's retention policy answers a
 * different question - how long a former resident's data is kept - and this
 * purpose ends on its own schedule whoever ordered and whether or not they still
 * live here.
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone.
 */
export const KEY_ORDER_RETENTION_DAYS = 365;

/**
 * The date a key order becomes erasable, or null while it is still open.
 *
 * @param closedAt When the order stopped being open, whichever way it closed.
 *   Null while it is with the board, which has no purge date at all rather than
 *   one far in the future - see the module comment.
 * @param retentionDays How long a closed order is kept.
 */
export function computeKeyOrderPurgeDate(
  closedAt: Date | null,
  retentionDays: number = KEY_ORDER_RETENTION_DAYS,
): Date | null {
  assertRetentionDays(retentionDays);

  if (closedAt === null) {
    return null;
  }

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computePurgeDate and computeMotionPurgeDate do it:
  // adding days in Europe/Stockholm shifts the result by an hour across a
  // daylight saving boundary, and a purge date an hour early is still an erasure
  // before the date the report stated.
  return new Date(
    closedAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest closing time whose purge date has arrived.
 *
 * An order closed on or before this is erasable; one closed after it is not, and
 * one that is still open is out of scope entirely - which the scan states as a
 * `closedAt: { not: null, lte: cutoff }` rather than relying on a comparison
 * against null.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait a year for it.
 * @param retentionDays How long a closed order is kept.
 */
export function keyOrderPurgeCutoff(
  now: Date,
  retentionDays: number = KEY_ORDER_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  return new Date(
    now.getTime() - Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both functions need, for the reason `purge-window.ts` gives:
 * a window that is not a number would otherwise put the cutoff in the future and
 * erase orders whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Key order retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

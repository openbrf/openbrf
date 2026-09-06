/**
 * How long a thread in the board's shared mailbox is kept, and when the purge
 * reaches it.
 *
 * A thread is service-tier personal data and among the least predictable this
 * platform holds: it is whatever somebody chose to write to their association,
 * which for a board's address means money, health, a dispute with a neighbour
 * and a third party's details, all of it arriving without anyone intending to
 * collect it. The purpose it is held for is dealing with what was asked, and
 * that purpose ends when the correspondence does.
 *
 * ## The anchor is the thread, not the person
 *
 * The residency purge cannot reach this table, and not because of an omission:
 * it erases the service data of somebody whose relationship with the cooperative
 * has ended, and most correspondents have no relationship with it at all. A
 * letter from a bank, a contractor, an authority or a neighbour in the next
 * building names nobody in the register, and one from a resident is still not
 * attributed to them - the address on a thread is what the envelope asserted,
 * and this module never resolves it to a person. So the clock runs on the thread
 * itself, from the last thing said in it, the way the news comment window runs
 * on the comment.
 *
 * The last message rather than the first, which is the one place this differs
 * from that window. A comment is one thing somebody said; a thread is a
 * conversation, and a conversation the board answered last month is not two
 * years old because it opened two years ago. Anchoring on the opening message
 * would put a live exchange past its retention date while it was still running.
 *
 * ## Why two years
 *
 * Longer than the year a news comment gets, and for a reason about what the
 * record is for rather than about how sensitive it is. What the board keeps here
 * is what the association was asked and what it answered, and the questions a
 * board is asked recur on the association's own cycle: a query about the
 * balcony rules, a complaint about the ventilation, a bank asking after a
 * transfer. One year would erase last spring's answer before this spring's
 * question arrives, and a board that cannot find what it said last time answers
 * differently, which is the failure this record exists to prevent. Two annual
 * general meetings is where that stops being true.
 *
 * Not a board setting, for the reason the news comment and booking windows are
 * not: the association's own retention policy is about a person whose
 * relationship with the cooperative has ended, and the board sets that because
 * the association is answerable for how long it keeps a former resident's data.
 * A letter's purpose ends with the matter it was about, whoever sent it.
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends. {@link computeBoardMailboxPurgeDate} answers "when is this thread
 * erased", which is a computation per row and what a data subject access report
 * states. {@link boardMailboxPurgeCutoff} asks the opposite question of the whole
 * table at once - "which threads have been quiet long enough" - which has to be
 * one comparison in SQL rather than a date computed for every thread ever
 * opened. If the two disagree the product erases on a day other than the one it
 * stated, so `board-mailbox-retention.spec.ts` runs them against each other
 * rather than trusting the arithmetic to look symmetrical.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** How long a thread is kept after the last message on it. Two years. */
export const BOARD_MAILBOX_RETENTION_DAYS = 730;

/**
 * The date a thread becomes erasable.
 *
 * @param lastMessageAt When the newest message on the thread arrived or was
 *   sent. The anchor, for the reason the module comment gives.
 * @param retentionDays How long a thread is kept.
 */
export function computeBoardMailboxPurgeDate(
  lastMessageAt: Date,
  retentionDays: number = BOARD_MAILBOX_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computePurgeDate and computeNewsCommentPurgeDate do
  // it: adding days in Europe/Stockholm shifts the result by an hour across a
  // daylight saving boundary, and a purge date an hour early is still an erasure
  // before the date the report stated.
  return new Date(
    lastMessageAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest last-message time whose purge date has arrived.
 *
 * A thread whose newest message is on or before this is erasable; one newer than
 * it is not.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait two years for it.
 * @param retentionDays How long a thread is kept.
 */
export function boardMailboxPurgeCutoff(
  now: Date,
  retentionDays: number = BOARD_MAILBOX_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  return new Date(
    now.getTime() - Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both functions need, for the reason purge-window.ts gives: a
 * window that is not a number would otherwise put the cutoff in the future and
 * erase threads whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Board mailbox retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

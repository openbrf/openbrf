/**
 * How long a chat message is kept, and when the purge reaches it.
 *
 * A message is service-tier personal data: it says which person wrote which
 * words in which room. The purpose it is held for is the conversation, and the
 * conversation is over long before the person leaves. So the clock is anchored
 * on the message's own `createdAt` rather than on a move-out - the same anchor
 * a news comment uses, and for the same reason.
 *
 * The anchor is the message and deliberately not the room. The board mailbox
 * keeps a thread for two years after the last message on it, which is right
 * there because a correspondence ends: it is one matter, it is dealt with, and
 * nothing more arrives. A chat has no end. Anchoring on the last message would
 * mean a board chat somebody writes in every week purges nothing, ever, and the
 * board's deliberation from six years ago would still be on the screen and on
 * every access report. So each message carries its own window, and the room
 * empties from the old end while the conversation carries on.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends. {@link computeChatMessagePurgeDate} answers "when is this message
 * erased", which is a computation per row and what a data subject access report
 * states. {@link chatMessagePurgeCutoff} asks the opposite question of the whole
 * table at once - "which messages were written long enough ago" - which has to
 * be one comparison in SQL rather than a date computed for every message ever
 * written. If the two disagree the product erases on a day other than the one it
 * stated, so `chat-retention.spec.ts` runs them against each other rather than
 * trusting the arithmetic to look symmetrical.
 *
 * The same shape as `news/news-comment-retention.ts`, and deliberately the same
 * number: both are service-tier records of what one person wrote to the others
 * who live here, and two different windows would be two answers to one question
 * nobody asked.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a message is kept after it was written.
 *
 * A constant rather than a board setting, for the reason the comment window is
 * one: the association's retention policy is about a person whose relationship
 * with the cooperative has ended, and the board sets it because the association
 * is answerable for how long it keeps a former resident's data. A message's
 * purpose ends with the conversation it belongs to, whoever wrote it and whether
 * or not they still live here.
 *
 * A year is what makes the room worth having while it is worth having: a board
 * asked the same question twice in a season wants last season's answers, and
 * somebody joining the board wants the winter's discussion of the roof. After
 * that it is a record of what one neighbour said about another, which the
 * association has no reason to hold and which the minutes cover for anything
 * that was actually decided.
 *
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job: every
 * pending purge date moves by that act alone.
 */
export const CHAT_MESSAGE_RETENTION_DAYS = 365;

/**
 * The date a message becomes erasable.
 *
 * @param writtenAt When the message was written. The anchor, for the reason the
 *   module comment gives.
 * @param retentionDays How long a message is kept.
 */
export function computeChatMessagePurgeDate(
  writtenAt: Date,
  retentionDays: number = CHAT_MESSAGE_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  // Day arithmetic on the UTC instant rather than calendar-field arithmetic in
  // local time, exactly as computePurgeDate and computeNewsCommentPurgeDate do
  // it: adding days in Europe/Stockholm shifts the result by an hour across a
  // daylight saving boundary, and a purge date an hour early is still an
  // erasure before the date the report stated.
  return new Date(
    writtenAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest writing time whose purge date has arrived.
 *
 * A message written on or before this is erasable; one written after it is not.
 *
 * @param now The moment the job is running at, passed in so a test can drive
 *   the clock rather than wait a year for it.
 * @param retentionDays How long a message is kept.
 */
export function chatMessagePurgeCutoff(
  now: Date,
  retentionDays: number = CHAT_MESSAGE_RETENTION_DAYS,
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
 * erase messages whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Chat message retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}

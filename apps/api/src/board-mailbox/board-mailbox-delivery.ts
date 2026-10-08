/**
 * What a reply's delivery record says when the answer did not go out.
 *
 * Codes, never prose, on the news mailing's and the meeting notice's rule: a
 * mail server's rejection quotes the envelope back, and the envelope is the
 * address of somebody who wrote to the association.
 *
 * Its own list rather than either of theirs, which is the same judgement those
 * two ledgers make about each other. A mailing has a code for a member the
 * association holds no telephone number for and a notice has one for a member it
 * cannot reach at all; a reply has neither, because it is answered to the
 * address the letter came from and that address is on the thread. Offering a
 * screen a code the module cannot produce leaves a board looking for a failure
 * that cannot happen.
 */
export const REPLY_DELIVERY_FAILURES = {
  /**
   * This instance has no mail server configured.
   *
   * The reply is on the thread all the same, which is the point of recording
   * this rather than refusing to accept the answer: the board wrote it, and what
   * failed is the sending.
   */
  mailNotConfigured: "mail-not-configured",

  /** The mail server refused the message. */
  refused: "send-failed",

  /**
   * The thread the reply belonged to is gone.
   *
   * Reachable because the sending is a background job and the purge is another:
   * a thread whose retention ran out between the board pressing send and the
   * worker reaching it has taken the reply with it, and the job says so rather
   * than failing.
   */
  threadGone: "thread-gone",

  /** The sending was given up on before it reached this reply. */
  interrupted: "reply-sending-interrupted",

  /**
   * The sending was given up on after an attempt had claimed this reply.
   *
   * That attempt stopped somewhere between the claim and the record of its
   * outcome - before the handover, during it, or after it with the record
   * failing - and nothing on the row says which. So the board is told that
   * nobody knows whether the answer went out, rather than that it did not:
   * a board told the latter sends it again.
   */
  unconfirmed: "reply-delivery-unconfirmed",
} as const;

export type ReplyDeliveryFailure =
  (typeof REPLY_DELIVERY_FAILURES)[keyof typeof REPLY_DELIVERY_FAILURES];

/**
 * Why a message in the mailbox is not stored, or is no longer.
 *
 * Its own list beside the delivery codes above. This one is written into the
 * ledger of messages the collector will not store, so a letter it can do
 * nothing with is not fetched again on every run for as long as the mailbox
 * keeps it, and the board's mailbox screen lists the letters it set aside by
 * it, so the board knows to open them in a mail client. A code rather than
 * prose here for the reason the others are: what could be quoted is a header a
 * stranger wrote.
 *
 * Two writers. The collector records a message it read and then left; the purge
 * records every message it erases with a thread, because that letter is still
 * in the mailbox and would otherwise be collected again.
 *
 * Only reasons that cannot change. A message this instance would store if it ran
 * again - one a retrieval failed on because the connection did - is not written
 * here at all, because a row saying so would make a temporary refusal permanent.
 * Nor is one whose listed size is over the limit: it is never fetched, so it
 * costs a run nothing.
 */
export const COLLECTION_REFUSALS = {
  /**
   * The message carried no address to answer.
   *
   * Every thread's correspondent column is an address a reply goes back to, so a
   * letter with no readable From header has nothing to open a thread with, and
   * no later run will find one: the bytes in the mailbox do not change.
   */
  noSenderAddress: "no-sender-address",

  /**
   * The message was stored once and its thread has since been purged.
   *
   * Nothing is deleted from the mailbox, so the letter is still there after its
   * thread is gone. Without this the next run would collect it again under its
   * old date, and the purge would erase it again the night after, for as long
   * as the mailbox keeps it.
   */
  purged: "purged",

  /**
   * The message is dated before the retention window, on the day it is first
   * read.
   *
   * Storing it would keep a letter the purge is due to erase that night, and
   * time only moves one way, so no later run would decide differently. The
   * date is held to when the mailbox received the letter, so a sender cannot
   * put a letter here by dating it in the past.
   */
  pastRetention: "past-retention",

  /**
   * The message is a further copy of an answer the board sent from here.
   *
   * The first copy is held under the answer itself, which has room for one. A
   * mailbox can hold more - a provider that files sent mail, a board that
   * copied its own address - and each of the others is recorded here, so it is
   * not fetched again on every run. It is the board's own words, so there is
   * nothing for the board to go and read.
   */
  ownAnswerCopy: "own-answer-copy",

  /**
   * The letter could not be stored.
   *
   * Either the database refused its values as they were read - the reader
   * removes what it knows a column cannot hold, and this is the answer for
   * whatever it has not foreseen: the same bytes read the same way are refused
   * the same way on every run, so the letter is set aside rather than left to
   * stop the collection of every letter behind it. Or it failed for some other
   * reason on every attempt for longer than the collector retries one, and is
   * then tried again now and then rather than never. A single
   * failure that says nothing about the letter - the database out of reach or
   * restarting, storage that did not answer - is not recorded here; see
   * `database-refusal.ts`.
   */
  unstorable: "unstorable",

  /**
   * The mailbox sent more of the message than this instance fetches, in bytes
   * or in time, though its listing said it was small enough to ask for.
   *
   * The response is abandoned part-way, which ends the session, so a letter
   * left to be fetched again would end every run at the same place and the
   * mail behind it would never be collected. It stays in the mailbox, where a
   * letter over the size limit is left too.
   */
  tooLarge: "too-large",
} as const;

export type CollectionRefusal =
  (typeof COLLECTION_REFUSALS)[keyof typeof COLLECTION_REFUSALS];

/**
 * The refusals the board's mailbox screen lists: a letter the board has not
 * read and should open in a mail client.
 *
 * Not a letter the purge erased, which the board did read and the association
 * no longer keeps, nor one already past the retention window when it was first
 * read, which it was never to keep, nor a copy of the board's own answer, which
 * it wrote. Those rows are there so the collector does
 * not store the letter again, and a screen that listed them would fill with
 * every thread the purge has taken.
 */
export const LISTED_REFUSALS: readonly CollectionRefusal[] = [
  COLLECTION_REFUSALS.noSenderAddress,
  COLLECTION_REFUSALS.unstorable,
  COLLECTION_REFUSALS.tooLarge,
];

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
} as const;

export type ReplyDeliveryFailure =
  (typeof REPLY_DELIVERY_FAILURES)[keyof typeof REPLY_DELIVERY_FAILURES];

/**
 * Why a collected message was read and then left.
 *
 * Its own list beside the delivery codes above, and read by nothing on a screen:
 * this one is written into the ledger of messages the collector will not store,
 * so a letter it can do nothing with is not fetched again on every run for as
 * long as the mailbox keeps it. A code rather than prose here for the reason the
 * others are: what could be quoted is a header a stranger wrote.
 *
 * Only reasons that cannot change. A message this instance would store if it ran
 * again - one too large to fetch, one a retrieval failed on - is not written
 * here at all, because a row saying so would make a temporary refusal permanent.
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
} as const;

export type CollectionRefusal =
  (typeof COLLECTION_REFUSALS)[keyof typeof COLLECTION_REFUSALS];

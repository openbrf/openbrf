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

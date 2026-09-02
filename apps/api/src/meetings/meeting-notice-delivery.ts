/**
 * What the notice's delivery ledger records when a copy did not go out.
 *
 * Codes, never prose. None of them repeats what a mail server said: a rejection
 * quotes the envelope back, and the envelope is a member's address.
 *
 * Its own list rather than the news mailing's, which is the same judgement the
 * ledger table itself makes. That list is shared by two channels and carries a
 * code for a member the association holds no telephone number for; a notice has
 * one channel, and offering a screen a code no notice can produce would leave a
 * board looking for a failure that cannot happen.
 */
export const NOTICE_DELIVERY_FAILURES = {
  /**
   * This instance has no mail server. The notice is issued all the same, and
   * the ledger is what says it reached nobody.
   */
  mailNotConfigured: "mail-not-configured",

  /** The mail server refused the message. */
  refused: "send-failed",

  /** The person the ledger names is no longer on this instance. */
  recipientGone: "recipient-gone",

  /**
   * The association holds no email address for this member.
   *
   * Written into the ledger and failed, rather than left out of the snapshot the
   * way the news mailing leaves out a member it holds no telephone number for.
   * The two ledgers answer different questions. A news mailing is an
   * announcement, and somebody it could not reach has missed an announcement
   * that is on the association's website anyway. A notice is a summons the
   * association owes every member (EFL 6 kap. 21 §), so a member this platform
   * cannot reach is precisely what the board has to be shown - in order to call
   * them another way, which is the only way that member is called at all.
   */
  noEmailAddress: "no-email-address",

  /** The sending was given up on before it reached this row. */
  interrupted: "notice-sending-interrupted",
} as const;

/**
 * What the delivery ledger records when a copy did not go out.
 *
 * Codes, never prose, and shared by both channels rather than owned by either
 * worker: the board's screen reads one ledger, and a reason spelled two ways
 * would be two ways for the same failure to be reported.
 *
 * None of them repeats what a mail server or an SMS gateway said. A rejection
 * quotes the envelope back, and the envelope is a member's address or phone
 * number.
 */
export const DELIVERY_FAILURES = {
  /** This instance has no mail server. The item is published all the same. */
  mailNotConfigured: "mail-not-configured",
  /** This instance has no SMS provider. The item is published all the same. */
  smsNotConfigured: "sms-not-configured",
  /** The mail server or the SMS gateway refused the message. */
  refused: "send-failed",
  /** The person is no longer in the register. */
  recipientGone: "recipient-gone",
  /**
   * There is no number to text.
   *
   * Its own code rather than recipient-gone, because it is not a person who
   * left: it is somebody in the register whom the association simply has no way
   * to reach this way. Members without a number are excluded from the snapshot
   * at publish and get no row at all; this is the narrower case of a number
   * removed, or made unusable, between the publish and the send.
   */
  noPhoneNumber: "no-phone-number",
  /** The mailing was given up on before it reached this row. */
  interrupted: "mailing-interrupted",
  /**
   * The person objected, or asked for a restriction, after the snapshot was
   * taken.
   *
   * The snapshot doctrine is that a published item mails the members it named
   * at publish, whatever changed afterwards - which is what makes a correction
   * and a retry reach nobody twice. This is its one documented exception. An
   * objection under GDPR art. 21 leaves no room to send: the association would
   * be processing on a legitimate interest the person has objected to and that
   * it has already decided not to defend. So the row fails with a code rather
   * than going out, and the board's delivery report counts it as a failure -
   * which it is, in the only sense that matters here.
   */
  recipientObjected: "recipient-objected",
} as const;

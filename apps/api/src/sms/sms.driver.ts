/**
 * Where a text message goes once the platform has composed it.
 *
 * One interface, so nothing above this line learns which provider an
 * association pays. That is what "open" means here in practice: a driver is a
 * file next to this one and a branch in the selection, and it needs nothing
 * from the news module, the register or the encryption layer. No provider's
 * SDK is a dependency of this application, and none may become one - a
 * cooperative that cannot change its SMS provider without a new release is
 * back where the vendor lock-in it left behind was.
 *
 * The interface is one message to one number, and deliberately not a batch.
 * The mailing ledger claims one recipient's row before that recipient's
 * message is handed over, and a driver that took several numbers at once would
 * make the claim cover people it had not yet sent to - which is exactly the
 * window the ledger exists to close.
 *
 * It reports nothing back. A provider's own message id would be a second
 * identifier for a delivery the ledger already records, and holding one would
 * invite the platform to ask the provider afterwards how that message went -
 * that is, to name the member to the provider a second time, for a status the
 * association has no use for.
 */

/**
 * Which driver answered. Named in logs and in settings, never in a response.
 *
 * "recording" is the in-process double the suites send through. It is named
 * here with the others rather than left to claim one of their names, because a
 * test double reporting itself as the no-provider driver would make a log line
 * say the opposite of what happened.
 */
export type SmsDriverKind = "none" | "http-gateway" | "recording";

/** One text message, composed and ready to send. */
export interface SmsMessage {
  /**
   * The recipient's number in E.164 form.
   *
   * Decrypted by the caller immediately before this call and held nowhere else:
   * a number never travels in a job payload, and no driver may keep one past
   * the send.
   */
  to: string;

  /**
   * The whole message, as plain text.
   *
   * SMS carries no markup and no alternative part, so what is composed here is
   * literally what a member reads. Bounded by the composer rather than by a
   * driver, because what a message may cost is the association's decision and
   * not a provider's.
   */
  body: string;

  /**
   * What the message appears to come from, where the provider supports one.
   *
   * Optional because sender identity is the one part of SMS that is not
   * portable: some routes take an alphanumeric name, some require a number
   * bought from the operator, and some ignore it entirely. A driver that cannot
   * use it drops it rather than failing - the message still has to arrive.
   */
  sender?: string;
}

export interface SmsDriver {
  readonly kind: SmsDriverKind;

  /**
   * Hands one message to the provider.
   *
   * Resolves when the provider has accepted it, which is not a claim that
   * anybody read it - the same thing an SMTP server's acceptance means. Throws
   * for everything else, because the caller records the failure on the
   * recipient's own ledger row and carries on to the next person.
   */
  send(message: SmsMessage): Promise<void>;
}

/**
 * This instance has no SMS provider.
 *
 * Its own class rather than an SmsError, because it is not a provider that
 * failed: it is an association that has not bought SMS, which is the ordinary
 * state of a fresh instance and of every instance that only ever mails. The
 * news mailing records it as the reason that delivery did not go out, and the
 * board's screen says so in as many words - what failed was the text message,
 * never the news item.
 */
export class SmsNotConfiguredError extends Error {
  constructor() {
    super(
      "This instance has no SMS provider. Text messages cannot be sent until " +
        "one is set up in settings.",
    );
    this.name = "SmsNotConfiguredError";
  }
}

/** An SMS provider that could not do what it was asked. */
export class SmsError extends Error {
  constructor(
    message: string,
    readonly kind: SmsDriverKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SmsError";
  }
}

import type { SmsDriver, SmsMessage } from "../sms.driver";

/**
 * A driver that keeps the messages instead of sending them.
 *
 * What a suite needs from SMS is the answer to "who was texted, and what did it
 * say" - so that is what this holds, in order, with nothing else in the way. It
 * reaches no network by construction rather than by configuration: there is no
 * address on it to point anywhere, so a test that accidentally sends for real
 * is not a mistake anybody can make here.
 *
 * `failWith` exists because the interesting half of the news mailing is the
 * failure path: one member's provider refusal must be written on that member's
 * ledger row and must not abandon the members after them.
 */
export class RecordingSmsDriver implements SmsDriver {
  readonly kind = "recording" as const;

  /** Every message handed over, in order. */
  readonly sent: SmsMessage[] = [];

  /** Thrown instead of recording, when set. */
  failWith: Error | undefined;

  send(message: SmsMessage): Promise<void> {
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The numbers texted, in order. The usual assertion. */
  get recipients(): string[] {
    return this.sent.map((message) => message.to);
  }
}

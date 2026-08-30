import {
  type SmsDriver,
  type SmsMessage,
  SmsNotConfiguredError,
} from "./sms.driver";

/**
 * The driver an instance has until somebody configures one.
 *
 * A driver rather than a null the callers check, so that "nothing is
 * configured" is a state the adapter can be in rather than a branch every call
 * site has to remember. There is no code path in which an unconfigured instance
 * quietly drops a message or accidentally sends one: the send fails, the reason
 * is recorded on the recipient's ledger row, and the board is told.
 *
 * It refuses in every environment, including development, which is where it
 * differs from the mail service. Mail logs the body locally because the message
 * carries a sign-in link a developer needs to follow; a news text message
 * carries a headline and a public address, so there is nothing to recover by
 * printing it - and printing it would put a member's phone number in a log.
 * Locally, nothing was sent, and that is what the screen says.
 */
export class NoSmsProviderDriver implements SmsDriver {
  readonly kind = "none" as const;

  send(_message: SmsMessage): Promise<void> {
    return Promise.reject(new SmsNotConfiguredError());
  }
}

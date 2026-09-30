import { MailApiError } from "./http-api-mail.driver";
import { MailNotConfiguredError } from "./mail.service";

/**
 * The codes a mail that did not leave carries: nodemailer's for the SMTP
 * conversation (connection, TLS, authentication, envelope, message, protocol)
 * and the two a socket raises when the server is not there. Not every `E`
 * code: ENOENT or EMFILE out of the same call is the process failing, not the
 * mail server refusing.
 */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ETLS",
  "EREQUIRETLS",
  "EAUTH",
  "ENOAUTH",
  "EENVELOPE",
  "EMESSAGE",
  "ESTREAM",
  "EPROTOCOL",
  "ECONNRESET",
  "ECONNREFUSED",
]);

/**
 * Whether a failure is the mail not leaving, as opposed to the code that sends
 * it being wrong.
 *
 * Three shapes count: no mail configured, the HTTP mail API refusing or not
 * answering, and an SMTP transport error. A caller that has already committed
 * its own work treats these as "not delivered" and carries on; a failure of any
 * other kind is a bug or a database fault and is not the delivery's to explain
 * away. What a caller's own refusals mean (an invitation to a person with no
 * address, say) is for that caller to decide.
 */
export function isDeliveryFailure(cause: unknown): boolean {
  if (
    cause instanceof MailNotConfiguredError ||
    cause instanceof MailApiError
  ) {
    return true;
  }
  if (!(cause instanceof Error)) {
    return false;
  }
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === "string" && TRANSPORT_CODES.has(code);
}

import { InvitationError } from "../invitations/invitation.service";
import { MailApiError } from "./http-api-mail.driver";
import { MailNotConfiguredError } from "./mail.service";

/**
 * Whether a failure is the mail not leaving, as opposed to the code that sends
 * it being wrong.
 *
 * Four shapes count: no mail configured, the HTTP mail API refusing or not
 * answering, an invitation that cannot go to this person (no address, or an
 * account already), and a transport error, which nodemailer and Node's sockets
 * both name with an `E` code (`ECONNECTION`, `ETIMEDOUT`, `EAUTH`,
 * `EENVELOPE`). A caller that has already committed its own work treats these
 * as "not delivered" and carries on; a failure of any other kind is a bug or a
 * database fault and is not the delivery's to explain away.
 */
export function isDeliveryFailure(cause: unknown): boolean {
  if (
    cause instanceof MailNotConfiguredError ||
    cause instanceof MailApiError ||
    cause instanceof InvitationError
  ) {
    return true;
  }
  if (!(cause instanceof Error)) {
    return false;
  }
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code);
}

import { HttpStatus } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";

import { DomainError } from "../http/domain-error";
import type { MailDriver, OutgoingMail, SentMail } from "./mail-driver";

/**
 * The port to use when the settings name none.
 *
 * Which one depends on the transport, and getting it wrong is a connection
 * failure rather than a cosmetic default: nodemailer's `secure` flag means
 * IMPLICIT TLS, which servers offer on 465, while 587 is the submission port
 * that starts in cleartext and upgrades through STARTTLS. Defaulting a secure
 * connection to 587 asks for a TLS handshake on a port that answers with a
 * greeting, and the send times out.
 */
const IMPLICIT_TLS_PORT = 465;
const STARTTLS_SUBMISSION_PORT = 587;

export function defaultPortFor(secure: boolean): number {
  return secure ? IMPLICIT_TLS_PORT : STARTTLS_SUBMISSION_PORT;
}

/**
 * How long a send may take before it is a failure.
 *
 * Stated rather than left to the transport, because every send in this
 * application is awaited by whatever triggered it - a request handler, or a
 * queue worker - and an unbounded one does not fail, it waits. That is the
 * worse outcome of the two: a caller that has already committed its work
 * catches a rejection and logs it, while a caller holding an open request holds
 * it for as long as the far end stays silent. The defaults are two minutes to
 * connect and ten on an idle socket, which is long enough for a stalled mail
 * server to be indistinguishable from a hung application.
 *
 * The numbers are generous for a working submission server, where the whole
 * exchange is a handshake and a few hundred bytes, and short enough that a
 * board member pressing "send test message" gets an answer.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * The server set up no encrypted connection, so nothing was sent to it.
 *
 * What a required STARTTLS ends in when the server does not offer it, or an
 * attacker on the path stripped the offer, or the upgrade fails: nodemailer's
 * `ETLS`. The sign-in was never sent. Its own reason, because the remedy is the
 * server's port and TLS mode rather than the password the generic failure
 * points at.
 *
 * A certificate the server presents and this process does not trust is not
 * among them. Nodemailer reports it as `ESOCKET`, the code a refused connection
 * has too, having written over the code that told them apart, so it stays the
 * generic failure rather than a guess from the wording of a message.
 *
 * A 502: the fault is at the mail server, not in the request.
 */
export class MailTlsUnavailableError extends DomainError {
  readonly status = HttpStatus.BAD_GATEWAY;
  readonly reason = "mail-tls-unavailable";

  constructor(options?: { cause: unknown }) {
    super(
      "The SMTP server set up no encrypted connection, so nothing was sent to it.",
    );
    // Kept for the stack in the log; the server's answer is never the message.
    if (options !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Whether nodemailer failed to set up TLS, which it reports as `ETLS`. */
function isTlsFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ETLS"
  );
}

/** An SMTP server and how to sign in to it. */
export interface SmtpServer {
  host: string;
  port: number;
  secure: boolean;
  /**
   * Whether a connection that starts in cleartext must upgrade through
   * STARTTLS before anything else is sent, the sign-in above all.
   *
   * Without it nodemailer upgrades only when the server offers to, so an
   * attacker on the path who strips the offer from the greeting receives the
   * password in the clear. Meaningless with `secure`, which is TLS from the
   * first byte.
   */
  requireTls: boolean;
  user: string | null;
  /** Decrypted by the caller, or read from the environment. */
  password: string | null;
}

/** Sending through an SMTP server, the board's own or the host's. */
export class SmtpMailDriver implements MailDriver {
  readonly kind = "smtp" as const;
  private readonly transporter: Transporter;

  constructor(server: SmtpServer) {
    this.transporter = createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      requireTLS: server.requireTls,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      auth:
        server.user === null
          ? undefined
          : { user: server.user, pass: server.password ?? "" },
    });
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    let info: unknown;
    try {
      info = await this.sendOne(mail);
    } catch (error) {
      if (isTlsFailure(error)) {
        throw new MailTlsUnavailableError({ cause: error });
      }
      throw error;
    }

    // Reported as the one delivered, which holds for a relay that keeps the
    // Message-ID it is given. One that writes its own (Amazon SES's SMTP
    // interface does) is documented as belonging behind the HTTP mail API
    // instead, since nothing in the SMTP answer names the identifier it wrote.
    // Without one, nodemailer wrote its own and reports it.
    return { messageId: mail.messageId ?? reportedMessageId(info) };
  }

  close(): void {
    this.transporter.close();
  }

  private async sendOne(mail: OutgoingMail): Promise<unknown> {
    return this.transporter.sendMail({
      // As an object when there is a name, which nodemailer encodes: a name
      // with a letter outside ASCII, or a quote, cannot be written into the
      // header as it stands. A bare address is passed as it always was.
      from:
        mail.from.name === null
          ? mail.from.address
          : { name: mail.from.name, address: mail.from.address },
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      replyTo: mail.replyTo ?? undefined,
      messageId: mail.messageId === null ? undefined : `<${mail.messageId}>`,
      // Both headers, from the one value. In-Reply-To names the message being
      // answered and References carries the conversation, and a client needs
      // the second to place the reply in a thread it is already showing.
      inReplyTo: mail.inReplyTo === null ? undefined : `<${mail.inReplyTo}>`,
      references: mail.inReplyTo === null ? undefined : [`<${mail.inReplyTo}>`],
    });
  }
}

/** The identifier nodemailer reports, without its angle brackets. */
function reportedMessageId(info: unknown): string | null {
  const reported =
    typeof info === "object" && info !== null && "messageId" in info
      ? info.messageId
      : undefined;
  if (typeof reported !== "string") {
    return null;
  }
  const bare = reported.replace(/^<|>$/g, "");
  return bare === "" ? null : bare;
}

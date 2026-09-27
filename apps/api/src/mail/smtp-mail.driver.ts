import { createTransport, type Transporter } from "nodemailer";

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

/** An SMTP server and how to sign in to it. */
export interface SmtpServer {
  host: string;
  port: number;
  secure: boolean;
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
    const info: unknown = await this.transporter.sendMail({
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

    // An SMTP server does not rewrite the Message-ID, so the one given is the
    // one delivered. Without one, nodemailer wrote its own and reports it.
    return { messageId: mail.messageId ?? reportedMessageId(info) };
  }

  close(): void {
    this.transporter.close();
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

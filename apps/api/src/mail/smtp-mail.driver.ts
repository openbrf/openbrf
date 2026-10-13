import { HttpStatus } from "@nestjs/common";
import {
  createTransport,
  type SMTPTransportOptions,
  type Transporter,
} from "nodemailer";

import { DomainError } from "../http/domain-error";
import {
  type ResolveAddresses,
  type ResolvedAddress,
  resolvePublicAddresses,
} from "../network/outbound-address";
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

/**
 * The server's host is not one this instance may connect to, so nothing was
 * sent to it.
 *
 * A host the board entered that is, or resolves to, a loopback, private or
 * link-local address, while whoever runs the instance has not allowed that
 * (OPENBRF_ALLOW_PRIVATE_HOSTS). Saving such a host is refused, so this is a
 * row saved before that check, or a name that has since moved.
 *
 * One answer whether the name resolved somewhere private or did not resolve
 * at all, because which of the two it was is a fact about the network behind
 * this instance. A 502, like the TLS refusal above.
 */
export class MailServerNotPublicError extends DomainError {
  readonly status = HttpStatus.BAD_GATEWAY;
  readonly reason = "host-not-public";

  constructor(options: { cause: unknown }) {
    super(
      "The SMTP server is not a public address this instance may connect to, so nothing was sent to it.",
    );
    this.cause = options.cause;
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
  /**
   * Whether the host may be on a private network.
   *
   * True for a server set in the environment, which whoever runs the instance
   * chose, and for one the board entered only where whoever runs the instance
   * allowed it (OPENBRF_ALLOW_PRIVATE_HOSTS). Otherwise the host is resolved
   * at each send, refused unless every address is public, and the connection
   * is made to the address that was checked.
   */
  allowPrivateHosts: boolean;
}

/** Sending through an SMTP server, the board's own or the host's. */
export class SmtpMailDriver implements MailDriver {
  readonly kind = "smtp" as const;
  /** The one transport, while the host is not checked; null while it is. */
  private readonly transporter: Transporter | null;

  constructor(
    private readonly server: SmtpServer,
    /** The resolver, for a suite that cannot depend on somebody's DNS zone. */
    private readonly resolve?: ResolveAddresses,
  ) {
    this.transporter = server.allowPrivateHosts
      ? createTransport(transportOptions(server))
      : null;
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
    this.transporter?.close();
  }

  /**
   * The transport for one send, and whether it is this send's alone.
   *
   * A checked host gets a transport per send, built on the address the check
   * approved: nodemailer resolves a name itself, and caches the answer, so a
   * transport built on the name would connect wherever that resolution said
   * rather than where this one did. The name stays the TLS server name, so a
   * certificate is still checked against the host the board entered.
   */
  private async transportFor(): Promise<{
    transporter: Transporter;
    own: boolean;
  }> {
    if (this.transporter !== null) {
      return { transporter: this.transporter, own: false };
    }

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await resolvePublicAddresses(this.server.host, {
        allowPrivate: false,
        ...(this.resolve === undefined ? {} : { resolve: this.resolve }),
      });
    } catch (cause) {
      throw new MailServerNotPublicError({ cause });
    }

    // IPv4 first where there is one, which is the order nodemailer tries a
    // name in: a container with no IPv6 route would otherwise fail on a host
    // that answers on both.
    const address =
      addresses.find((answer) => answer.family === 4) ?? addresses[0];
    return {
      transporter: createTransport(
        transportOptions(this.server, address?.address),
      ),
      own: true,
    };
  }

  private async sendOne(mail: OutgoingMail): Promise<unknown> {
    const { transporter, own } = await this.transportFor();
    try {
      return await this.sendThrough(transporter, mail);
    } finally {
      if (own) {
        transporter.close();
      }
    }
  }

  private async sendThrough(
    transporter: Transporter,
    mail: OutgoingMail,
  ): Promise<unknown> {
    return transporter.sendMail({
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

/**
 * What a transport for this server is built with, connecting to `address` when
 * one is given and to the host by name when not.
 */
function transportOptions(
  server: SmtpServer,
  address?: string,
): SMTPTransportOptions {
  return {
    host: address ?? server.host,
    // The name the certificate is checked against, and the one presented for
    // SNI, when the connection is made to an address.
    ...(address === undefined ? {} : { servername: server.host }),
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
  };
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

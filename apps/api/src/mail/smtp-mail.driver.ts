import { connect } from "node:net";

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
import {
  type MailDriver,
  type MailHandover,
  type MailHandoverFailure,
  NEVER_CONNECTED_SYSTEM_CODES,
  type OutgoingMail,
  type SentMail,
  withHandover,
} from "./mail-driver";

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
 * has too, so it stays the generic failure. The record of the send still reads
 * it as not handed over, from the code nodemailer keeps under its own
 * (`NEVER_CONNECTED_SYSTEM_CODES`).
 *
 * A 502: the fault is at the mail server, not in the request.
 */
export class MailTlsUnavailableError
  extends DomainError
  implements MailHandoverFailure
{
  readonly status = HttpStatus.BAD_GATEWAY;
  readonly reason = "mail-tls-unavailable";
  readonly handover = "not-handed-over";

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
export class MailServerNotPublicError
  extends DomainError
  implements MailHandoverFailure
{
  readonly status = HttpStatus.BAD_GATEWAY;
  readonly reason = "host-not-public";
  readonly handover = "not-handed-over";

  constructor(options: { cause: unknown }) {
    super(
      "The SMTP server is not a public address this instance may connect to, so nothing was sent to it.",
    );
    this.cause = options.cause;
  }
}

/**
 * Nodemailer's codes for a failure before the message was sent, or for the
 * server refusing it: no address for the name, no encrypted connection, a
 * sign-in, an envelope or a DATA command refused, and a message refused, by the
 * server's answer to it or by nodemailer before it was sent.
 */
const BEFORE_HANDOVER_CODES: ReadonlySet<string> = new Set([
  "EDNS",
  "ETLS",
  "EREQUIRETLS",
  "EAUTH",
  "ENOAUTH",
  "EENVELOPE",
  "EMESSAGE",
]);

/**
 * Nodemailer's timeouts that can only run out before the message is sent: the
 * TCP connect, the greeting and the TLS upgrade. Not `SOCKET_TIMEOUT`, which
 * runs on every exchange, the end of the message's included.
 */
const BEFORE_HANDOVER_TIMEOUTS: ReadonlySet<string> = new Set([
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);

/**
 * How far a send nodemailer failed had got, from the fields it gives its
 * errors.
 *
 * Nodemailer reports a socket that broke or went quiet with one code and one
 * command (`CONN`) whatever the conversation had reached, and the end of the
 * message is one of those points: the server may have taken it and its answer
 * been lost. So such a failure may have been handed over, unless the field it
 * carries places it before the connection was made. Nodemailer keeps the
 * system or TLS code it wrapped under its own (`originalCode`), which is how a
 * refused connection and an expired certificate, both reported as `ESOCKET`,
 * are told from a reset.
 *
 * A reply code on a `CONN` protocol error places it before the handover as
 * well: nodemailer raises that for a greeting that is not a 220, and for a
 * reply nobody awaits, which only arrives once the answer to the message has
 * been taken and the send has already resolved.
 */
function smtpHandover(error: unknown): MailHandover {
  if (typeof error !== "object" || error === null) {
    return "may-have-been-handed-over";
  }
  const { code, timeoutType, originalCode, command, responseCode } = error as {
    code?: unknown;
    timeoutType?: unknown;
    originalCode?: unknown;
    command?: unknown;
    responseCode?: unknown;
  };
  const before =
    (typeof code === "string" && BEFORE_HANDOVER_CODES.has(code)) ||
    // A server that answers the connection with a refusal (a 554 or 421 where
    // the 220 greeting belongs) is reported as `EPROTOCOL` on the connection
    // (`CONN`) with the server's reply code. A connection that broke or went
    // quiet carries no reply code, and stays ambiguous.
    (code === "EPROTOCOL" &&
      command === "CONN" &&
      typeof responseCode === "number") ||
    (code === "ETIMEDOUT" &&
      typeof timeoutType === "string" &&
      BEFORE_HANDOVER_TIMEOUTS.has(timeoutType)) ||
    (typeof originalCode === "string" &&
      NEVER_CONNECTED_SYSTEM_CODES.has(originalCode));
  return before ? "not-handed-over" : "may-have-been-handed-over";
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
    /** The greeting timeout, for a suite that cannot wait ten seconds for it. */
    private readonly timeouts: { greetingTimeoutMs?: number } = {},
  ) {
    this.transporter = server.allowPrivateHosts
      ? createTransport(
          transportOptions(server, undefined, undefined, timeouts),
        )
      : null;
  }

  async send(mail: OutgoingMail, signal?: AbortSignal): Promise<SentMail> {
    let info: unknown;
    try {
      info = await this.sendOne(mail, signal);
    } catch (error) {
      // The caller's deadline, whatever nodemailer made of the closed socket.
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      if (isTlsFailure(error)) {
        throw new MailTlsUnavailableError({ cause: error });
      }
      throw withHandover(error, smtpHandover(error));
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
   *
   * A send with a signal gets one of its own too, whose socket the signal
   * closes (`connectUntil`): the shared transport opens sockets of its own
   * that nothing here can reach.
   */
  private async transportFor(signal: AbortSignal | undefined): Promise<{
    transporter: Transporter;
    own: boolean;
  }> {
    if (this.transporter !== null && signal === undefined) {
      return { transporter: this.transporter, own: false };
    }

    let address: string | undefined;
    if (!this.server.allowPrivateHosts) {
      let addresses: readonly ResolvedAddress[];
      try {
        // Raced rather than cancelled, which the system resolver cannot be: a
        // lookup carries no part of the message, and nothing is connected to
        // once the signal is aborted.
        addresses = await untilAborted(
          resolvePublicAddresses(this.server.host, {
            allowPrivate: false,
            ...(this.resolve === undefined ? {} : { resolve: this.resolve }),
          }),
          signal,
        );
      } catch (cause) {
        if (signal?.aborted === true) {
          throw signal.reason;
        }
        throw new MailServerNotPublicError({ cause });
      }

      // IPv4 first where there is one, which is the order nodemailer tries a
      // name in: a container with no IPv6 route would otherwise fail on a host
      // that answers on both.
      address = (
        addresses.find((answer) => answer.family === 4) ?? addresses[0]
      )?.address;
    }

    signal?.throwIfAborted();
    return {
      transporter: createTransport(
        transportOptions(this.server, address, signal, this.timeouts),
      ),
      own: true,
    };
  }

  private async sendOne(
    mail: OutgoingMail,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const { transporter, own } = await this.transportFor(signal);
    try {
      // Raced as well, so the caller hears of the abort when it comes: the
      // socket is closed by then, and what nodemailer reports of it later is
      // left unread.
      return await untilAborted(this.sendThrough(transporter, mail), signal);
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
 * one is given and to the host by name when not, over a socket `signal` closes
 * when one is given.
 */
function transportOptions(
  server: SmtpServer,
  address?: string,
  signal?: AbortSignal,
  timeouts: { greetingTimeoutMs?: number } = {},
): SMTPTransportOptions {
  return {
    ...(signal === undefined ? {} : { getSocket: connectUntil(signal) }),
    host: address ?? server.host,
    // The name the certificate is checked against, and the one presented for
    // SNI, when the connection is made to an address.
    ...(address === undefined ? {} : { servername: server.host }),
    port: server.port,
    secure: server.secure,
    requireTLS: server.requireTls,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: timeouts.greetingTimeoutMs ?? GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    auth:
      server.user === null
        ? undefined
        : { user: server.user, pass: server.password ?? "" },
  };
}

/**
 * Opens the connection for nodemailer, on a socket the signal destroys.
 *
 * Nodemailer takes no signal, and the socket it opens itself is out of reach,
 * so the connection is opened here and handed to it as a proxy's would be.
 * Destroying it is what ends the send where it stands: TLS, which nodemailer
 * still sets up over it, runs on this socket, and once it is destroyed no
 * further byte of the conversation leaves this process (the deadline spec runs
 * both implicit TLS and STARTTLS over it). The connect is bounded
 * as nodemailer bounds its own.
 */
function connectUntil(
  signal: AbortSignal,
): NonNullable<SMTPTransportOptions["getSocket"]> {
  return (options, callback) => {
    if (signal.aborted) {
      callback(signal.reason as Error);
      return;
    }
    let settled = false;
    const socket = connect({
      host: options.host,
      port: Number(options.port),
      signal,
    });
    const timedOut = (): void => {
      socket.destroy(
        Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }),
      );
    };
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    socket.once("timeout", timedOut);
    socket.once("connect", () => {
      settled = true;
      // Nodemailer sets its own bounds on the open socket.
      socket.setTimeout(0);
      socket.removeListener("timeout", timedOut);
      callback(null, { connection: socket });
    });
    socket.once("error", (error) => {
      if (!settled) {
        settled = true;
        callback(error);
      }
    });
  };
}

/**
 * `work`, or the signal's reason as soon as it is aborted. What `work` comes
 * to after that is left unread.
 */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return work;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
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

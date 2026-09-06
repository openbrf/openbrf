import { connect as connectPlain, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

/**
 * A POP3 client, to the extent RFC 1939 is needed to collect a board's mailbox.
 *
 * ## Why POP3, and why written here
 *
 * The inbound half of a shared board mailbox is the one design decision this
 * module turns on, and it is answered by what the platform promises about
 * deployment: an association installs Open BRF with one Compose command, on one
 * host, and the board configures the rest itself from a settings screen.
 *
 * Receiving mail directly would break that. An SMTP listener needs port 25 open
 * to the internet, an MX record, a public hostname with a certificate, reverse
 * DNS, SPF and DMARC alignment, and a spam defence - none of which a board can
 * be asked to arrange, and every one of which is a way for the association's own
 * mail to stop arriving with nobody to ask. An inbound webhook from a mail
 * provider needs the association to hold a contract with that provider and a
 * publicly reachable URL, which is a second deployment shape and a dependency on
 * a company. Collecting from a mailbox needs none of it: the board already has a
 * mailbox at whoever hosts its domain, because that is where the address it
 * publishes lives, and this instance reaches out to it exactly as a mail client
 * would.
 *
 * POP3 rather than IMAP because of what each protocol is for. IMAP is a protocol
 * for keeping a client's view of a server-side folder tree in sync - flags,
 * folders, partial fetches, a state machine with an extension for every
 * behaviour - and this module wants one thing from the mailbox: the letters it
 * has not seen. POP3 answers exactly that question in six commands, which is
 * what makes it small enough to write against the specification rather than to
 * take a dependency for. What is given up is the ability to mark a message read
 * on the server or to file it in a folder, and neither is something the board
 * does from here: the application is where a letter is worked, and the mailbox
 * is a delivery point.
 *
 * Nothing is deleted from the server. `DELE` is not implemented and is not
 * wanted: the mailbox belongs to the association rather than to this instance,
 * a board may well also read it in a mail client, and a collection that emptied
 * it would be this platform quietly taking custody of correspondence somebody
 * else may be relying on. Not collecting the same letter twice is instead the
 * caller's job, decided by the unique identifiers `UIDL` returns and the unique
 * constraint they are stored under.
 *
 * ## What this deliberately does not implement
 *
 * No `APOP`, no `SASL`, no `STLS`. Authentication is `USER`/`PASS` over an
 * implicitly encrypted connection, which is what port 995 offers and what every
 * hosting provider a Swedish housing cooperative buys a domain from supports.
 * Cleartext is available because a test double and a mailbox on the same host
 * are real cases, and it is off by default: a password on the wire has to be
 * something the board chose rather than something the software defaulted to.
 */

/** How long the connection may take to establish. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long the far end may stay silent mid-exchange.
 *
 * Stated rather than left to the socket for the reason `MailService` states its
 * own: every use of this is awaited by something - a request handler answering a
 * board member who pressed a button, or a scheduled job - and an unbounded wait
 * does not fail, it hangs. A stalled mail server and a hung application are then
 * indistinguishable.
 */
const IDLE_TIMEOUT_MS = 20_000;

/**
 * How long one whole response may take to arrive.
 *
 * The idle timeout above bounds a server that goes silent. It does not bound one
 * that keeps talking: a far end trickling a byte every few seconds resets the
 * idle timer for ever, and without a deadline this client would sit in that loop
 * until the process ended. The two bounds answer different failures and both are
 * needed - a mailbox is at the far end of somebody else's network, and one of
 * the two states it can leave a client in has no error to catch.
 */
const RESPONSE_DEADLINE_MS = 120_000;

/**
 * The longest single status line this client will read.
 *
 * A status line is "+OK" or "-ERR" and a short sentence, and RFC 1939 bounds it
 * at 512 octets. This is generous against that and finite against a server that
 * never sends the terminator, which is the failure it exists for: without it the
 * buffer grows for as long as the far end keeps writing, and the idle timer never
 * fires because bytes keep arriving.
 */
const MAX_STATUS_LINE_BYTES = 8 * 1024;

/**
 * The default ceiling on a multi-line response.
 *
 * The listing commands have no size to check beforehand, unlike a message, whose
 * octet count the server states in LIST before anything is fetched. A mailbox
 * holding ten thousand messages produces a listing of a few hundred kilobytes,
 * so this is far above any real one and still a bound - which is what a response
 * from a machine outside the association has to have.
 */
const MAX_LISTING_BYTES = 1024 * 1024;

/** Ports each transport is offered on when the settings name none. */
export const POP3_IMPLICIT_TLS_PORT = 995;
export const POP3_CLEARTEXT_PORT = 110;

export function defaultPop3Port(secure: boolean): number {
  return secure ? POP3_IMPLICIT_TLS_PORT : POP3_CLEARTEXT_PORT;
}

export interface Pop3Credentials {
  host: string;
  port: number;
  /** Implicit TLS from the first byte, which is what port 995 offers. */
  secure: boolean;
  user: string;
  password: string;
}

/** One message sitting in the mailbox, as the server describes it. */
export interface Pop3Listing {
  /**
   * The message's number in this session, which is what `RETR` takes.
   *
   * Session-scoped and never stored: the server renumbers between sessions, so
   * a number kept from one poll would name a different letter at the next.
   */
  readonly number: number;
  /** The server's unique identifier for it, from `UIDL`. Stable across sessions. */
  readonly uid: string;
  /** Its size in octets, from `LIST`, so an oversized one is skipped unread. */
  readonly octets: number;
}

/**
 * A refusal from the mailbox, as a code.
 *
 * Codes rather than the server's own words, on the delivery ledgers' rule: a
 * POP3 error response quotes the mailbox name back, and the mailbox name is the
 * board's address.
 */
export class Pop3Error extends Error {
  constructor(
    message: string,
    readonly reason:
      "connect-failed" | "authentication-failed" | "protocol-error" | "timeout",
  ) {
    super(message);
    this.name = "Pop3Error";
  }
}

export interface Pop3Session {
  /** Every message in the mailbox, with its identifier and its size. */
  list(): Promise<readonly Pop3Listing[]>;
  /**
   * One message, whole.
   *
   * @param maxBytes Refuses past this many octets rather than reading on. The
   *   caller has the size from {@link list} and is expected not to ask for a
   *   message over its own limit; this is the second line, for a server whose
   *   `LIST` size disagrees with what it then sends. Every multi-line response
   *   has a ceiling, this one included - a response with no bound is a way for
   *   a machine outside the association to decide how much memory this process
   *   uses.
   */
  retrieve(number: number, maxBytes: number): Promise<Buffer>;
  /** Ends the session politely, and never throws. */
  close(): Promise<void>;
}

/**
 * Signs in to a mailbox and hands back a session.
 *
 * The caller closes it, in a `finally`: a session left open holds a connection
 * on the far end until its own idle timer fires, and a mailbox provider counts
 * concurrent connections.
 */
export async function openPop3Session(
  credentials: Pop3Credentials,
): Promise<Pop3Session> {
  const connection = await openConnection(credentials);

  try {
    // The greeting. A server that does not greet is not a POP3 server, and
    // saying so here is a better answer than a failure three commands later.
    await connection.readStatusLine();
    await connection.command(
      `USER ${credentials.user}`,
      "authentication-failed",
    );
    await connection.command(
      `PASS ${credentials.password}`,
      "authentication-failed",
    );
  } catch (error) {
    connection.destroy();
    throw error;
  }

  return {
    async list(): Promise<readonly Pop3Listing[]> {
      const sizes = parseListing(await connection.multilineCommand("LIST"));
      const uids = parseListing(await connection.multilineCommand("UIDL"));

      const listings: Pop3Listing[] = [];
      for (const [number, octetsText] of sizes) {
        const uid = uids.get(number);
        const octets = Number.parseInt(octetsText, 10);
        if (uid === undefined || !Number.isFinite(octets)) {
          /*
           * A message LIST names and UIDL does not cannot be collected safely:
           * without an identifier there is nothing to record it under, so the
           * next poll would fetch it again and the board would read it twice.
           * Skipping it leaves it in the mailbox, where a board member can still
           * read it in a mail client - which is the failure that loses least.
           */
          continue;
        }
        listings.push({ number, uid, octets });
      }
      return listings;
    },

    async retrieve(number: number, maxBytes: number): Promise<Buffer> {
      return connection.multilineCommand(`RETR ${String(number)}`, maxBytes);
    },

    async close(): Promise<void> {
      await connection.quit();
    },
  };
}

/** `LIST` and `UIDL` both answer "<number> <value>" a line at a time. */
function parseListing(body: Buffer): Map<number, string> {
  const entries = new Map<number, string>();
  for (const line of body.toString("latin1").split("\r\n")) {
    // Both fields are ASCII by the grammar, so latin1 is a byte-preserving
    // decode rather than a guess at an encoding.
    const separator = line.indexOf(" ");
    if (separator === -1) {
      continue;
    }
    const number = Number.parseInt(line.slice(0, separator), 10);
    const value = line.slice(separator + 1).trim();
    if (Number.isFinite(number) && value !== "") {
      entries.set(number, value);
    }
  }
  return entries;
}

/** The socket, and the line protocol spoken over it. */
interface Connection {
  readStatusLine(): Promise<string>;
  command(text: string, reason: Pop3Error["reason"]): Promise<string>;
  multilineCommand(text: string, maxBytes?: number): Promise<Buffer>;
  quit(): Promise<void>;
  destroy(): void;
}

async function openConnection(
  credentials: Pop3Credentials,
): Promise<Connection> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const settle = (error: Error): void => {
      reject(
        new Pop3Error(
          `The mailbox at ${credentials.host} could not be reached: ${error.name}`,
          "connect-failed",
        ),
      );
    };

    const pending = credentials.secure
      ? connectTls({
          host: credentials.host,
          port: credentials.port,
          // The certificate is checked. A mailbox reached over a connection
          // whose far end was not verified is a password handed to whoever
          // answered, and the board pasted that password in believing otherwise.
          servername: credentials.host,
        })
      : connectPlain({ host: credentials.host, port: credentials.port });

    const onReady = (): void => {
      pending.setTimeout(0);
      pending.off("error", settle);
      resolve(pending);
    };

    pending.setTimeout(CONNECT_TIMEOUT_MS, () => {
      pending.destroy();
      reject(
        new Pop3Error(
          `The mailbox at ${credentials.host} did not answer in time.`,
          "timeout",
        ),
      );
    });
    pending.once("error", settle);
    pending.once(credentials.secure ? "secureConnect" : "connect", onReady);
  });

  /*
   * Everything the socket has produced and this parser has not yet consumed.
   *
   * A Buffer rather than a string, and consumed by looking for CRLF bytes: a
   * message body arrives in whatever encoding its parts declare, and decoding
   * the stream as text before the MIME layer has read those declarations would
   * corrupt every part that is not UTF-8. The line protocol itself is ASCII, so
   * the framing can be done on bytes and the content handed on untouched.
   */
  let buffered = Buffer.alloc(0);
  let failure: Error | null = null;
  let waiting: (() => void) | null = null;

  const wake = (): void => {
    const resume = waiting;
    waiting = null;
    resume?.();
  };

  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  });
  socket.on("error", (error: Error) => {
    failure ??= new Pop3Error(
      `The connection to the mailbox failed: ${error.name}`,
      "protocol-error",
    );
    wake();
  });
  socket.on("close", () => {
    failure ??= new Pop3Error(
      "The mailbox closed the connection.",
      "protocol-error",
    );
    wake();
  });

  /** Waits for more bytes, or fails when none can come. */
  const readMore = async (): Promise<void> => {
    if (failure !== null) {
      throw failure;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = null;
        socket.destroy();
        reject(new Pop3Error("The mailbox stopped answering.", "timeout"));
      }, IDLE_TIMEOUT_MS);

      waiting = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });
    if (failure !== null && buffered.length === 0) {
      throw failure;
    }
  };

  /** One CRLF-terminated line, without its terminator. */
  const readLine = async (): Promise<string> => {
    for (;;) {
      const end = buffered.indexOf("\r\n");
      if (end !== -1) {
        const line = buffered.subarray(0, end).toString("latin1");
        buffered = buffered.subarray(end + 2);
        return line;
      }
      if (buffered.length > MAX_STATUS_LINE_BYTES) {
        // A line this long is not a status line, and waiting for a terminator
        // that is not coming is how a client hangs rather than fails.
        socket.destroy();
        throw new Pop3Error(
          "The mailbox sent a line longer than the protocol allows.",
          "protocol-error",
        );
      }
      await readMore();
    }
  };

  const send = (text: string): void => {
    socket.write(`${text}\r\n`);
  };

  const readStatusLine = async (): Promise<string> => {
    const line = await readLine();
    if (line.startsWith("+OK")) {
      return line.slice(3).trim();
    }
    throw new Pop3Error(
      // The server's own words are deliberately not repeated: a POP3 error
      // response quotes the mailbox name back, and that is the board's address.
      "The mailbox refused the command.",
      "protocol-error",
    );
  };

  return {
    readStatusLine,

    async command(text: string, reason): Promise<string> {
      send(text);
      try {
        return await readStatusLine();
      } catch (error) {
        if (error instanceof Pop3Error && error.reason === "protocol-error") {
          throw new Pop3Error(error.message, reason);
        }
        throw error;
      }
    },

    async multilineCommand(
      text: string,
      maxBytes = MAX_LISTING_BYTES,
    ): Promise<Buffer> {
      send(text);
      await readStatusLine();

      // A whole response, not just a quiet one. See RESPONSE_DEADLINE_MS.
      const deadline = Date.now() + RESPONSE_DEADLINE_MS;

      /*
       * Multi-line responses end with "." alone on a line, and a line of the
       * body that would itself begin with "." is sent with an extra one
       * (RFC 1939 section 3, "byte-stuffing"). Undoing that here rather than in
       * the MIME layer is what keeps the two apart: everything above this line
       * is the transport, and everything below it is a message.
       */
      const lines: Buffer[] = [];
      let total = 0;
      for (;;) {
        if (Date.now() > deadline) {
          socket.destroy();
          throw new Pop3Error(
            "The mailbox did not finish its answer in time.",
            "timeout",
          );
        }

        const end = buffered.indexOf("\r\n");
        if (end === -1) {
          if (total + buffered.length > maxBytes) {
            socket.destroy();
            throw new Pop3Error(
              "The mailbox sent more than this client accepts.",
              "protocol-error",
            );
          }
          await readMore();
          continue;
        }

        const line = buffered.subarray(0, end);
        buffered = buffered.subarray(end + 2);

        if (line.length === 1 && line[0] === 0x2e) {
          return Buffer.concat(lines);
        }

        const unstuffed = line[0] === 0x2e ? line.subarray(1) : line;
        total += unstuffed.length + 2;
        if (total > maxBytes) {
          // Destroyed rather than drained: the rest of a response this size is
          // not worth the time, and the session is not reusable once one has
          // been abandoned part-way.
          socket.destroy();
          throw new Pop3Error(
            "The mailbox sent more than this client accepts.",
            "protocol-error",
          );
        }
        lines.push(unstuffed, CRLF);
      }
    },

    async quit(): Promise<void> {
      try {
        send("QUIT");
        await readStatusLine();
      } catch {
        // A mailbox that will not say goodbye has nothing left to tell us, and
        // the letters are already collected. The socket is closed either way.
      } finally {
        socket.destroy();
      }
    },

    destroy(): void {
      socket.destroy();
    },
  };
}

const CRLF = Buffer.from("\r\n", "latin1");

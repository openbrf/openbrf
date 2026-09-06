import { createServer, type Server, type Socket } from "node:net";

/**
 * A POP3 server that holds whatever a test puts in it.
 *
 * The same shape as `sms/testing/sms-gateway-test-server.ts` and
 * `storage/testing/s3-test-server.ts`, and for the same reason those exist: the
 * client under test speaks a wire protocol, and a mock of the client's own
 * methods would test the mock. What this proves is the part that is easy to get
 * wrong and impossible to see in a unit test that stubs it - the multi-line
 * terminator, the byte-stuffing an RFC 1939 server applies to a line beginning
 * with a full stop, and a response arriving split across several packets.
 *
 * Deliberately not a complete server. It answers the six commands the client
 * sends and refuses everything else, which is what makes it useful: a client
 * that started sending something new would fail here rather than silently
 * against a permissive double.
 */
export interface Pop3TestServerOptions {
  user: string;
  password: string;
  /** The mailbox, as raw message bodies keyed by their unique identifier. */
  messages: readonly { uid: string; raw: string }[];
  /**
   * Writes a multi-line response one byte at a time.
   *
   * The client reassembles the stream itself, so a response that arrives whole
   * exercises none of that. One test turns this on to prove a message split
   * across many reads comes back identical.
   */
  trickle?: boolean;
  /**
   * Answers a multi-line command with a stream that never terminates.
   *
   * The failure this exists for is the one with no exception to catch: a server
   * that keeps writing and never sends the "." line leaves a client reading for
   * ever, and the idle timer never fires because bytes keep arriving. A test
   * against it proves the client has a bound rather than proving a parse result.
   */
  neverTerminate?: boolean;
  /** Answers with a status line longer than the protocol allows. */
  floodStatusLine?: boolean;
}

export interface Pop3TestServer {
  port: number;
  /** Commands the client sent, in order, for the tests that assert on them. */
  received: readonly string[];
  close(): Promise<void>;
}

export async function startPop3TestServer(
  options: Pop3TestServerOptions,
): Promise<Pop3TestServer> {
  const received: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // Nothing here should ever surface as an unhandled error: a test that
    // destroys a connection mid-response is testing exactly that.
    socket.on("error", () => undefined);

    let authenticated = false;
    let buffered = "";

    const write = (text: string): void => {
      if (options.trickle === true) {
        for (const character of text) {
          socket.write(character);
        }
        return;
      }
      socket.write(text);
    };

    /** A multi-line body, byte-stuffed and terminated, as RFC 1939 requires. */
    const writeMultiline = (body: string): void => {
      const lines = body.split("\r\n").map((line) =>
        // The stuffing the client has to undo: a line that begins with a full
        // stop is sent with a second one so it cannot be read as the terminator.
        line.startsWith(".") ? `.${line}` : line,
      );
      write(`${lines.join("\r\n")}\r\n.\r\n`);
    };

    /**
     * Keeps writing the given chunk until the client gives up.
     *
     * The chunk is the caller's because the two floods are different failures.
     * A response that never terminates is made of well-formed lines with the
     * "." line missing, so the client's line framing is exercised rather than
     * bypassed. A status line that never ends carries no CRLF at all - and it
     * has to carry none, or the client finds a line boundary and the test passes
     * for a reason that has nothing to do with the bound it exists for.
     */
    const flood = (chunk: string): void => {
      const pump = (): void => {
        if (socket.destroyed || socket.writableEnded) {
          return;
        }
        socket.write(chunk);
        setTimeout(pump, 1);
      };
      pump();
    };

    if (options.floodStatusLine === true) {
      // The greeting, with no terminator, for ever. This is the first line the
      // client reads, so the bound it needs is on the very first read.
      socket.write("+OK ");
      flood("x".repeat(4096));
      return;
    }

    socket.write("+OK Mailbox ready\r\n");

    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      for (;;) {
        const end = buffered.indexOf("\r\n");
        if (end === -1) {
          return;
        }
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        received.push(line);

        const [verb = "", argument = ""] = line.split(" ");
        const command = verb.toUpperCase();

        if (command === "USER") {
          write(
            argument === options.user ? "+OK\r\n" : "-ERR no such mailbox\r\n",
          );
        } else if (command === "PASS") {
          authenticated = argument === options.password;
          write(authenticated ? "+OK signed in\r\n" : "-ERR bad password\r\n");
        } else if (!authenticated) {
          write("-ERR not signed in\r\n");
        } else if (options.neverTerminate === true) {
          write("+OK here it comes\r\n");
          flood("1 1000\r\n".repeat(256));
        } else if (command === "LIST") {
          write(`+OK ${String(options.messages.length)} messages\r\n`);
          writeMultiline(
            options.messages
              .map(
                (message, index) =>
                  `${String(index + 1)} ${String(Buffer.byteLength(message.raw, "latin1"))}`,
              )
              .join("\r\n"),
          );
        } else if (command === "UIDL") {
          write("+OK\r\n");
          writeMultiline(
            options.messages
              .map((message, index) => `${String(index + 1)} ${message.uid}`)
              .join("\r\n"),
          );
        } else if (command === "RETR") {
          const message = options.messages[Number.parseInt(argument, 10) - 1];
          if (message === undefined) {
            write("-ERR no such message\r\n");
          } else {
            write(
              `+OK ${String(Buffer.byteLength(message.raw, "latin1"))} octets\r\n`,
            );
            writeMultiline(message.raw);
          }
        } else if (command === "QUIT") {
          write("+OK goodbye\r\n");
          socket.end();
        } else {
          write("-ERR unknown command\r\n");
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test POP3 server did not bind a port");
  }

  return {
    port: address.port,
    received,
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

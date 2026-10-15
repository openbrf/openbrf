import { type AddressInfo, createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResolveAddresses } from "../network/outbound-address";
import { defaultPop3Port, openPop3Session, Pop3Error } from "./pop3";
import {
  startPop3TestServer,
  type Pop3TestServer,
} from "./testing/pop3-test-server";

/**
 * The POP3 client, against a server that speaks the protocol.
 *
 * Every case here is one this client would otherwise get wrong silently. A
 * mis-read multi-line terminator does not throw, it returns a truncated message;
 * un-stuffed byte-stuffing does not throw either, it quietly deletes a full stop
 * from the start of a line in somebody's letter; and a size limit that is only
 * checked after a whole response has been read is not a limit at all.
 */

const CREDENTIALS = {
  host: "127.0.0.1",
  secure: false,
  user: "styrelsen",
  password: "hemligt-losenord",
} as const;

/**
 * Where the test server listens: on loopback, which a mailbox may be only
 * where whoever runs the instance allowed private hosts. The cases about where
 * a mailbox may be say otherwise.
 */
const ON_LOOPBACK = { allowPrivateHosts: true } as const;

let server: Pop3TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function message(uid: string, body: string): { uid: string; raw: string } {
  return {
    uid,
    raw: [
      "From: Astrid <astrid@example.test>",
      "Subject: Fragan",
      "",
      body,
    ].join("\r\n"),
  };
}

/**
 * A server that answers a multi-line command with bytes built beforehand.
 *
 * Written as they are rather than composed from strings, which is what the test
 * server proper does: for a response of millions of lines that composing is on
 * the same heap as the client under test, and would be most of what a test of
 * the client's memory measured. The bytes are sent as the body, so they have to
 * be stuffed already; a command it holds none for is answered with an empty one.
 */
async function startPrebuiltServer(
  responses: Partial<Record<"LIST" | "UIDL" | "RETR", Buffer>>,
): Promise<{ port: number; close(): Promise<void> }> {
  const listener = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.write("+OK ready\r\n");
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      for (;;) {
        const end = pending.indexOf("\r\n");
        if (end === -1) {
          return;
        }
        const verb = (pending.slice(0, end).split(" ")[0] ?? "").toUpperCase();
        pending = pending.slice(end + 2);
        if (verb === "LIST" || verb === "UIDL" || verb === "RETR") {
          socket.write("+OK\r\n");
          socket.write(responses[verb] ?? Buffer.alloc(0));
          socket.write(".\r\n");
        } else if (verb === "QUIT") {
          socket.end("+OK\r\n");
        } else {
          socket.write("+OK\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (listener.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        listener.close(() => resolve());
      }),
  };
}

describe("defaultPop3Port", () => {
  it("offers the implicit TLS port for an encrypted connection", () => {
    // 995 and 110 are not interchangeable: 995 starts its handshake on connect
    // and 110 answers with a greeting, so the wrong one is a failed connection
    // rather than a cosmetic default.
    expect(defaultPop3Port(true)).toBe(995);
    expect(defaultPop3Port(false)).toBe(110);
  });
});

describe("openPop3Session", () => {
  it("lists every message with its identifier and its size", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", "Hej"), message("uid-two", "Hej igen")],
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );
    try {
      const listings = await session.list();

      expect(listings).toHaveLength(2);
      expect(listings.map((listing) => listing.uid)).toEqual([
        "uid-one",
        "uid-two",
      ]);
      expect(listings.map((listing) => listing.number)).toEqual([1, 2]);
      expect(listings[0]?.octets).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it("undoes the byte-stuffing on a line that begins with a full stop", async () => {
    // The case the specification has a rule for and nothing else in this suite
    // would reach. A client that does not undo it deletes a character from the
    // start of a line in a letter somebody wrote, silently.
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", ".. and then this")],
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );
    try {
      const raw = await session.retrieve(1, 1_000_000);

      // The whole line, compared exactly. A substring assertion would pass
      // through the regression it exists for: the stuffed form ("... and then
      // this") contains the unstuffed one, so `toContain` on the message text
      // is true whether or not the client undid anything.
      const lines = raw.toString("utf8").split("\r\n");
      expect(lines).toContain(".. and then this");
      expect(lines).not.toContain("... and then this");

      // And the terminator itself is not part of the message.
      expect(raw.toString("utf8")).not.toMatch(/\r\n\.\r\n$/);
    } finally {
      await session.close();
    }
  });

  it("reassembles a response that arrives a byte at a time", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", "Vattenlacka i tvattstugan")],
      trickle: true,
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );
    try {
      const raw = await session.retrieve(1, 1_000_000);
      expect(raw.toString("utf8")).toContain("Vattenlacka i tvattstugan");
    } finally {
      await session.close();
    }
  });

  it("refuses a message larger than the caller allows", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", "x".repeat(5000))],
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );

    // While it is being read, not after: the whole point of a limit on input
    // from outside the association is that the process never holds the excess.
    // And said as its own reason, because the letter is what is at fault and
    // the caller records it rather than fetching it again on every run.
    await expect(session.retrieve(1, 500)).rejects.toMatchObject({
      reason: "too-large",
    });
    // The rest of the response was not read, so the session cannot be asked
    // anything else, and says so rather than failing the next command.
    expect(session.isOpen()).toBe(false);
  });

  it("stays open after the mailbox refuses one message", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", "Hej")],
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );
    try {
      // A refusal is a whole answer: nothing is left unread on the connection,
      // so the letters behind this one can still be fetched.
      await expect(session.retrieve(2, 1_000_000)).rejects.toBeInstanceOf(
        Pop3Error,
      );
      expect(session.isOpen()).toBe(true);
      const raw = await session.retrieve(1, 1_000_000);
      expect(raw.toString("utf8")).toContain("Hej");
    } finally {
      await session.close();
    }
  });

  it("lists a mailbox whose listing runs past a mebibyte", async () => {
    // About 17,000 letters under identifiers as long as a large provider's. A
    // board mailbox that has received for a decade holds that many, and a
    // listing bound below it would refuse the mailbox on every run for good.
    const uidTail = "x".repeat(60);
    const messages = Array.from({ length: 17_000 }, (_, index) => ({
      uid: `${String(index)}-${uidTail}`,
      raw: "From: <a@example.test>\r\n\r\nHej",
    }));
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages,
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );
    try {
      const listings = await session.list();
      expect(listings).toHaveLength(messages.length);
    } finally {
      await session.close();
    }
  });

  describe("a response of millions of short lines", () => {
    /*
     * The ceiling on a response counts its bytes, and a blank line is two of
     * them. A letter of nothing else, inside the ceiling, is millions of lines,
     * and a client that held each one as an object of its own would spend
     * hundreds of megabytes of heap on one letter a stranger only had to send
     * to the board's address - enough to end the process, and since nothing is
     * deleted from the mailbox, to end it again on every run.
     *
     * Measured as the heap the client grows by while it reads. The bytes of the
     * response are not on the heap, so what this sees is the per-line cost and
     * nothing else; a client that copies into one buffer grows it by almost
     * nothing.
     */
    const HEAP_ALLOWANCE = 64 * 1024 * 1024;

    async function heapGrowthWhile<T>(
      work: () => Promise<T>,
    ): Promise<{ result: T; growth: number }> {
      const before = process.memoryUsage().heapUsed;
      let peak = before;
      const sample = (): void => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      };
      // Between the packets the response arrives in, which is where a client
      // holding a line at a time has grown.
      const sampler = setInterval(sample, 1);
      try {
        const result = await work();
        sample();
        return { result, growth: peak - before };
      } finally {
        clearInterval(sampler);
      }
    }

    it("reads a letter of blank lines without an object for each", async () => {
      const lines = 4_500_000;
      const prebuilt = await startPrebuiltServer({
        RETR: Buffer.alloc(lines * 2, "\r\n", "latin1"),
      });
      const session = await openPop3Session(
        { ...CREDENTIALS, port: prebuilt.port },
        ON_LOOPBACK,
      );
      try {
        const { result, growth } = await heapGrowthWhile(() =>
          session.retrieve(1, 10 * 1024 * 1024),
        );
        expect(result.length).toBe(lines * 2);
        expect(result.equals(Buffer.alloc(lines * 2, "\r\n", "latin1"))).toBe(
          true,
        );
        expect(growth).toBeLessThan(HEAP_ALLOWANCE);
      } finally {
        await session.close();
        await prebuilt.close();
      }
    }, 60_000);

    it("reads a listing of blank lines without an object for each", async () => {
      // As close to the listing ceiling as whole lines go. Only a mailbox
      // server can send this, but the listing is where the ceiling is highest.
      const lines = 8_000_000;
      const prebuilt = await startPrebuiltServer({
        LIST: Buffer.alloc(lines * 2, "\r\n", "latin1"),
      });
      const session = await openPop3Session(
        { ...CREDENTIALS, port: prebuilt.port },
        ON_LOOPBACK,
      );
      try {
        const { result, growth } = await heapGrowthWhile(() => session.list());
        expect(result).toEqual([]);
        expect(growth).toBeLessThan(HEAP_ALLOWANCE);
      } finally {
        await session.close();
        await prebuilt.close();
      }
    }, 60_000);
  });

  it("reports a refused sign-in as its own kind of failure", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: "something-else",
      messages: [],
    });

    // Distinguished from an unreachable host because it is the one a board can
    // act on: it means the password is wrong.
    await expect(
      openPop3Session({ ...CREDENTIALS, port: server.port }, ON_LOOPBACK),
    ).rejects.toMatchObject({ reason: "authentication-failed" });
  });

  it("never repeats what the server said about the mailbox", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: "something-else",
      messages: [],
    });

    // A POP3 error response quotes the mailbox name back, and that is the
    // board's own address. The failure carries a code and a sentence this file
    // wrote, and nothing the far end sent.
    const failure = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Pop3Error);
    expect((failure as Error).message).not.toContain("bad password");
  });

  it("gives up on a response that never terminates", async () => {
    /*
     * The failure with no exception to catch. A server that keeps writing and
     * never sends the terminator resets the idle timer with every packet, so
     * what has to be proved here is that a bound exists at all - not that a
     * parse came out right.
     *
     * The listing commands are where this bites, because unlike a message there
     * is no size stated beforehand to check against.
     */
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [],
      neverTerminate: true,
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );

    await expect(session.list()).rejects.toBeInstanceOf(Pop3Error);
  }, 30_000);

  it("gives up on a status line that never ends", async () => {
    // The same failure one layer down: a first line with no terminator, which a
    // client waiting for CRLF would buffer for as long as the far end wrote.
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [],
      floodStatusLine: true,
    });

    await expect(
      openPop3Session({ ...CREDENTIALS, port: server.port }, ON_LOOPBACK),
    ).rejects.toBeInstanceOf(Pop3Error);
  }, 30_000);

  it("leaves every message in the mailbox", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", "Hej")],
    });

    const session = await openPop3Session(
      { ...CREDENTIALS, port: server.port },
      ON_LOOPBACK,
    );
    await session.list();
    await session.retrieve(1, 1_000_000);
    await session.close();

    // The mailbox belongs to the association and a board may well also read it
    // in a mail client. Not collecting the same letter twice is decided by the
    // unique identifier, never by emptying somebody else's mailbox.
    expect(server.received).not.toContain("DELE 1");
    expect(server.received.some((line) => line.startsWith("DELE"))).toBe(false);
  });
});

describe("where the mailbox may be", () => {
  /*
   * The host is an administrator's word, and the board is told how the
   * connection went. A host on the network behind the instance is refused
   * before anything is sent to it, and the connection is made to the address
   * that was judged rather than to whatever the name answers next.
   *
   * Names under `.invalid`, which no resolver answers, so a case that reaches
   * the test server did so through the address it was handed.
   */
  const NAME = "pop.mailbox.invalid";
  const PUBLIC_ONLY = { allowPrivateHosts: false } as const;
  const toLoopback: ResolveAddresses = () =>
    Promise.resolve([{ address: "127.0.0.1", family: 4 }]);

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["127.0.0.1", "169.254.169.254"])(
    "refuses a mailbox at %s without connecting to it",
    async (host) => {
      server = await startPop3TestServer({
        user: CREDENTIALS.user,
        password: CREDENTIALS.password,
        messages: [],
      });

      await expect(
        openPop3Session(
          { ...CREDENTIALS, host, port: server.port },
          PUBLIC_ONLY,
        ),
      ).rejects.toMatchObject({ reason: "host-not-public" });
      // Not even the user name went over the wire.
      expect(server.received).toEqual([]);
    },
  );

  it("refuses a name that resolves to loopback without connecting to it", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [],
    });

    await expect(
      openPop3Session(
        { ...CREDENTIALS, host: NAME, port: server.port },
        { ...PUBLIC_ONLY, resolve: toLoopback },
      ),
    ).rejects.toMatchObject({ reason: "host-not-public" });
    expect(server.received).toEqual([]);
  });

  it("connects to the address it judged, not to a second answer", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", "Hej")],
    });

    // The name resolves nowhere for the socket, so a session means the
    // connection was made to the answer the check was given.
    const session = await openPop3Session(
      { ...CREDENTIALS, host: NAME, port: server.port },
      { ...ON_LOOPBACK, resolve: toLoopback },
    );
    try {
      expect(await session.list()).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it("presents the name, not the address, for the certificate", async () => {
    // A listener that reads the TLS ClientHello and hangs up. The server name
    // it carries is what the certificate is checked against.
    const hello = new Promise<Buffer>((resolve) => {
      const listener = createServer((socket) => {
        socket.once("data", (chunk: Buffer) => {
          resolve(chunk);
          socket.destroy();
          listener.close();
        });
      });
      listener.listen(0, "127.0.0.1", () => {
        const { port } = listener.address() as AddressInfo;
        void openPop3Session(
          { ...CREDENTIALS, host: NAME, port, secure: true },
          { ...ON_LOOPBACK, resolve: toLoopback },
        ).catch(() => undefined);
      });
    });

    expect((await hello).includes(Buffer.from(NAME, "latin1"))).toBe(true);
  });

  it("gives up on a resolver that never answers, within the connect deadline", async () => {
    vi.useFakeTimers();
    const stalled: ResolveAddresses = () => new Promise(() => undefined);

    const outcome = expect(
      openPop3Session(
        { ...CREDENTIALS, host: NAME, port: 110 },
        { ...PUBLIC_ONLY, resolve: stalled },
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("reports a name that does not resolve as unreachable where private hosts are allowed", async () => {
    // Nothing is held back there, so the refusal is the ordinary one.
    const missing: ResolveAddresses = () =>
      Promise.reject(new Error("ENOTFOUND"));

    await expect(
      openPop3Session(
        { ...CREDENTIALS, host: NAME, port: 110 },
        { ...ON_LOOPBACK, resolve: missing },
      ),
    ).rejects.toMatchObject({ reason: "connect-failed" });
  });
});

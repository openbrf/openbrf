import { afterEach, describe, expect, it } from "vitest";

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

    const session = await openPop3Session({
      ...CREDENTIALS,
      port: server.port,
    });
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

    const session = await openPop3Session({
      ...CREDENTIALS,
      port: server.port,
    });
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

    const session = await openPop3Session({
      ...CREDENTIALS,
      port: server.port,
    });
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

    const session = await openPop3Session({
      ...CREDENTIALS,
      port: server.port,
    });

    // While it is being read, not after: the whole point of a limit on input
    // from outside the association is that the process never holds the excess.
    await expect(session.retrieve(1, 500)).rejects.toBeInstanceOf(Pop3Error);
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
      openPop3Session({ ...CREDENTIALS, port: server.port }),
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
    const failure = await openPop3Session({
      ...CREDENTIALS,
      port: server.port,
    }).catch((error: unknown) => error);

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

    const session = await openPop3Session({
      ...CREDENTIALS,
      port: server.port,
    });

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
      openPop3Session({ ...CREDENTIALS, port: server.port }),
    ).rejects.toBeInstanceOf(Pop3Error);
  }, 30_000);

  it("leaves every message in the mailbox", async () => {
    server = await startPop3TestServer({
      user: CREDENTIALS.user,
      password: CREDENTIALS.password,
      messages: [message("uid-one", "Hej")],
    });

    const session = await openPop3Session({
      ...CREDENTIALS,
      port: server.port,
    });
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

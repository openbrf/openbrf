import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";

import type { OutgoingMail } from "./mail-driver";
import { SmtpMailDriver } from "./smtp-mail.driver";

/**
 * Whether a send ends where it stands when the caller's signal is aborted.
 *
 * A caller that holds a lock across the handoff (an issue's mail, under the
 * type's ring-fence) aborts the send before its transaction's limit can let the
 * lock go. The property is what reaches the wire after the abort, so it is
 * tested against a real SMTP conversation: a server that stalls at the point
 * under test, and records every line it received and whether the connection
 * was closed on it.
 */

/** Every line the server received, in order. */
let received: string[] = [];
/** How many connections were made, and how many the client closed. */
let opened = 0;
let closed = 0;
/** The verb the server goes quiet at, or null for one that answers it all. */
let stallAt: string | null = null;
let server: Server;
let port: number;

function answer(socket: Socket): void {
  opened += 1;
  socket.on("close", () => {
    closed += 1;
  });
  socket.on("error", () => {
    // The client hanging up mid-conversation is the case under test.
  });
  socket.setEncoding("utf8");
  if (stallAt === "GREETING") {
    return;
  }
  socket.write("220 relay.test ESMTP\r\n");
  let buffered = "";
  let inData = false;
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let end = buffered.indexOf("\r\n");
    while (end !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      end = buffered.indexOf("\r\n");
      received.push(line);
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write("250 queued\r\n");
        }
        continue;
      }
      const verb = line.split(/[ :]/)[0]?.toUpperCase() ?? "";
      if (verb === stallAt) {
        continue;
      }
      if (verb === "EHLO") {
        socket.write("250-relay.test\r\n250 8BITMIME\r\n");
      } else if (verb === "DATA") {
        inData = true;
        socket.write("354 go ahead\r\n");
      } else if (verb === "QUIT") {
        socket.end("221 bye\r\n");
      } else {
        socket.write("250 ok\r\n");
      }
    }
  });
}

beforeAll(async () => {
  server = createServer(answer);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  received = [];
  opened = 0;
  closed = 0;
  stallAt = null;
});

const MAIL: OutgoingMail = {
  from: { name: null, address: "utskick@delad.example" },
  to: "anna@exempel.se",
  subject: "Ärende 12",
  html: "<p>Ärende 12 har fått ett nytt meddelande</p>",
  text: "Ärende 12 har fått ett nytt meddelande",
  replyTo: null,
  messageId: null,
  inReplyTo: null,
};

function driver(): SmtpMailDriver {
  return new SmtpMailDriver({
    host: "127.0.0.1",
    port,
    secure: false,
    requireTls: false,
    user: null,
    password: null,
    // The test relay listens on loopback.
    allowPrivateHosts: true,
  });
}

/** Resolves once the server has seen the client close `count` connections. */
async function closedOn(count: number): Promise<void> {
  const until = Date.now() + 2000;
  while (closed < count && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a send whose signal is aborted", () => {
  it("ends at a server that never greets, well before the greeting's bound", async () => {
    // Without the signal reaching the socket the send would wait out the
    // greeting's ten seconds, and this test's own limit, below them.
    stallAt = "GREETING";
    const deadline = AbortSignal.timeout(200);
    const started = Date.now();

    const failure = await driver()
      .send(MAIL, deadline)
      .catch((error: unknown) => error);

    expect(failure).toBe(deadline.reason);
    expect(Date.now() - started).toBeLessThan(2000);
    await closedOn(1);
    expect(closed).toBe(1);
  }, 5000);

  it("hands nothing more over once it is aborted mid-conversation", async () => {
    // The server goes quiet after the recipient. The abort closes the
    // connection there, so the message itself never reaches it, and no
    // reply the server sends later could be answered with it.
    stallAt = "RCPT";
    const deadline = AbortSignal.timeout(200);

    const failure = await driver()
      .send(MAIL, deadline)
      .catch((error: unknown) => error);

    expect(failure).toBe(deadline.reason);
    await closedOn(1);
    expect(closed).toBe(1);
    expect(received.some((line) => line.startsWith("RCPT"))).toBe(true);
    expect(received.some((line) => line === "DATA")).toBe(false);
  }, 5000);

  it("connects to nothing when it was aborted before the send began", async () => {
    const aborted = AbortSignal.abort();

    await expect(driver().send(MAIL, aborted)).rejects.toBe(aborted.reason);
    expect(opened).toBe(0);
  });
});

describe("a send whose signal is not aborted", () => {
  it("hands the message over as it would without one, and closes its connection", async () => {
    // The control case: the server above does take a message, so the
    // assertions there are about the abort and not about the server.
    const sent = await driver().send(MAIL, new AbortController().signal);

    expect(sent.messageId).not.toBeNull();
    expect(received.some((line) => line === "DATA")).toBe(true);
    expect(received.some((line) => line === ".")).toBe(true);
    await closedOn(1);
    expect(closed).toBe(1);
  });
});

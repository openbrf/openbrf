import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer as createTlsServer,
  getCACertificates,
  setDefaultCACertificates,
  TLSSocket,
} from "node:tls";

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
/** The lines that arrived over TLS, and those that did not, in order. */
let encrypted: string[] = [];
let clear: string[] = [];
/** How many connections were made, and how many the client closed. */
let opened = 0;
let closed = 0;
/** The verb the server goes quiet at, or null for one that answers it all. */
let stallAt: string | null = null;
/** Called when the server reaches the verb it goes quiet at. */
let onStall: (() => void) | null = null;
let server: Server;
let port: number;

/**
 * The server's side of one conversation on `socket`. `offerStartTls` has it
 * advertise STARTTLS and wrap the socket when asked, and `isEncrypted` marks the
 * lines it reads as arriving over TLS.
 */
function converse(
  socket: Socket,
  options: { offerStartTls: boolean; isEncrypted: boolean },
): void {
  socket.on("error", () => {
    // The client hanging up mid-conversation is the case under test.
  });
  socket.setEncoding("utf8");
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
      (options.isEncrypted ? encrypted : clear).push(line);
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write("250 queued\r\n");
        }
        continue;
      }
      const verb = line.split(/[ :]/)[0]?.toUpperCase() ?? "";
      if (verb === stallAt) {
        onStall?.();
        continue;
      }
      if (verb === "EHLO") {
        socket.write(
          options.offerStartTls
            ? "250-relay.test\r\n250-STARTTLS\r\n250 8BITMIME\r\n"
            : "250-relay.test\r\n250 8BITMIME\r\n",
        );
      } else if (verb === "STARTTLS") {
        socket.write("220 ready to start TLS\r\n");
        socket.removeAllListeners("data");
        converse(
          new TLSSocket(socket, {
            isServer: true,
            key: tlsKey,
            cert: tlsCertificate,
          }),
          { offerStartTls: false, isEncrypted: true },
        );
        return;
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

/** Counts a connection, and its close, as the client sees it. */
function accept(socket: Socket, mode: "plain" | "starttls" | "implicit"): void {
  opened += 1;
  socket.on("close", () => {
    closed += 1;
  });
  if (stallAt === "GREETING") {
    socket.on("error", () => {
      // As above.
    });
    return;
  }
  socket.write("220 relay.test ESMTP\r\n");
  converse(socket, {
    offerStartTls: mode === "starttls",
    isEncrypted: mode === "implicit",
  });
}

/**
 * A certificate for the loopback address, made for this run and trusted by the
 * client for it: the TLS cases below need a server a send can complete with.
 */
let tlsKey = "";
let tlsCertificate = "";
let tlsDirectory = "";
let trustedBefore: string[] = [];
let tlsServer: Server;
let tlsPort: number;

beforeAll(async () => {
  tlsDirectory = mkdtempSync(join(tmpdir(), "smtp-deadline-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(tlsDirectory, "key.pem"),
      "-out",
      join(tlsDirectory, "cert.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  tlsKey = readFileSync(join(tlsDirectory, "key.pem"), "utf8");
  tlsCertificate = readFileSync(join(tlsDirectory, "cert.pem"), "utf8");
  trustedBefore = getCACertificates("default");
  setDefaultCACertificates([...trustedBefore, tlsCertificate]);

  server = createServer((socket) => {
    accept(socket, "starttls");
  });
  tlsServer = createTlsServer(
    { key: tlsKey, cert: tlsCertificate },
    (socket) => {
      accept(socket, "implicit");
    },
  );
  await Promise.all([
    new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    }),
    new Promise<void>((resolve) => {
      tlsServer.listen(0, "127.0.0.1", resolve);
    }),
  ]);
  port = (server.address() as AddressInfo).port;
  tlsPort = (tlsServer.address() as AddressInfo).port;
});

afterAll(async () => {
  setDefaultCACertificates(trustedBefore);
  rmSync(tlsDirectory, { recursive: true, force: true });
  await Promise.all(
    [server, tlsServer].map(
      (listening) =>
        new Promise<void>((resolve) => {
          listening.close(() => {
            resolve();
          });
        }),
    ),
  );
});

beforeEach(() => {
  received = [];
  encrypted = [];
  clear = [];
  opened = 0;
  closed = 0;
  stallAt = null;
  onStall = null;
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

function driver(
  tls: "none" | "starttls" | "implicit" = "none",
): SmtpMailDriver {
  return new SmtpMailDriver({
    host: "127.0.0.1",
    port: tls === "implicit" ? tlsPort : port,
    secure: tls === "implicit",
    requireTls: tls === "starttls",
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

describe.each(["starttls", "implicit"] as const)(
  "a send over %s, whose signal is aborted",
  (tls) => {
    // Nodemailer sets TLS up on the socket the driver hands it, and the abort
    // destroys that socket: the tests show the message does not reach a server
    // that stalls once TLS is up, and that TLS was in fact up when it stalled.
    it("hands nothing more over once it is aborted mid-conversation", async () => {
      stallAt = "RCPT";
      const controller = new AbortController();
      onStall = () => {
        controller.abort(new Error("deadline"));
      };

      const failure = await driver(tls)
        .send(MAIL, controller.signal)
        .catch((error: unknown) => error);

      expect(failure).toBe(controller.signal.reason);
      await closedOn(1);
      expect(closed).toBe(1);
      expect(encrypted.some((line) => line.startsWith("RCPT"))).toBe(true);
      expect(received.some((line) => line === "DATA")).toBe(false);
      if (tls === "starttls") {
        // Nothing but the request for TLS was said in the clear.
        expect(clear.map((line) => line.split(" ")[0])).toEqual([
          "EHLO",
          "STARTTLS",
        ]);
      }
    }, 5000);

    it("ends at a server that never greets", async () => {
      stallAt = "GREETING";
      const deadline = AbortSignal.timeout(200);

      const failure = await driver(tls)
        .send(MAIL, deadline)
        .catch((error: unknown) => error);

      expect(failure).toBe(deadline.reason);
      await closedOn(1);
      expect(closed).toBe(1);
    }, 5000);

    it("hands the message over when it is not aborted, over TLS", async () => {
      const sent = await driver(tls).send(MAIL, new AbortController().signal);

      expect(sent.messageId).not.toBeNull();
      expect(encrypted.some((line) => line === "DATA")).toBe(true);
      expect(encrypted.some((line) => line === ".")).toBe(true);
      await closedOn(1);
      expect(closed).toBe(1);
    });
  },
);

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

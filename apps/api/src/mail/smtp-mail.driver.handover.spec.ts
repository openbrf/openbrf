import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { mayHaveBeenHandedOver, type OutgoingMail } from "./mail-driver";
import { SmtpMailDriver } from "./smtp-mail.driver";

/**
 * How far a failed send had got, as the driver states it on what the real
 * nodemailer makes of a real SMTP conversation.
 *
 * The unit table in `smtp-mail.driver.spec.ts` shows the mapping from the
 * fields nodemailer gives its errors to an answer. It cannot show that the
 * installed nodemailer gives those fields to these failures: a double returns
 * whatever the test hands it, so a release that renamed `originalCode` or
 * `timeoutType`, or reported a failure after the message was streamed under
 * `EMESSAGE`, would pass it and move the cases that matter most to the wrong
 * side. Each case here is one a mail server produces, and the answer is read
 * off the error nodemailer built.
 */

/** What the server does once it has the end of the message (the lone `.`). */
type AfterData = "accept" | "refuse" | "hang-up";

interface Behaviour {
  /** Whether the greeting is sent when the client connects. */
  greeting: boolean;
  afterData: AfterData;
}

const servers: Server[] = [];
const sockets = new Set<Socket>();
const drivers: SmtpMailDriver[] = [];

/** A submission server that answers `behaviour` and offers no AUTH. */
async function listen(behaviour: Behaviour): Promise<number> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    // The client hanging up mid-conversation is one of the cases under test.
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    if (behaviour.greeting) {
      socket.write("220 relay.test ESMTP\r\n");
    }
    let buffered = "";
    let inData = false;
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let end = buffered.indexOf("\r\n");
      while (end !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf("\r\n");
        if (inData) {
          if (line === ".") {
            inData = false;
            if (behaviour.afterData === "accept") {
              socket.write("250 queued\r\n");
            } else if (behaviour.afterData === "refuse") {
              socket.write("554 message refused\r\n");
            } else {
              // The message has been sent in full, and no answer comes.
              socket.destroy();
            }
          }
          continue;
        }
        const verb = line.split(" ")[0]?.toUpperCase() ?? "";
        if (verb === "EHLO") {
          socket.write("250 relay.test\r\n");
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
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) {
    driver.close();
  }
  // `close` waits for the connections that are open, and a server that never
  // greeted holds one until the client gives up.
  for (const socket of sockets) {
    socket.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

const MAIL: OutgoingMail = {
  from: { name: null, address: "utskick@delad.example" },
  to: "anna@exempel.se",
  subject: "Ett arbetsorder väntar",
  html: "<p>Ett arbetsorder väntar</p>",
  text: "Ett arbetsorder väntar",
  replyTo: null,
  messageId: null,
  inReplyTo: null,
};

/** What `send` throws against the server on `port`. */
async function failureAt(
  port: number,
  options?: { greetingTimeoutMs: number },
): Promise<unknown> {
  const driver = new SmtpMailDriver(
    {
      host: "127.0.0.1",
      port,
      secure: false,
      requireTls: false,
      user: null,
      password: null,
      // The test server listens on loopback.
      allowPrivateHosts: true,
    },
    undefined,
    options,
  );
  drivers.push(driver);
  const outcome = await driver.send(MAIL).then(
    () => new Error("the send resolved"),
    (error: unknown) => error,
  );
  return outcome;
}

describe("a send that fails against a real SMTP conversation", () => {
  it("says a server nobody listens at was not handed over", async () => {
    // A port that was free a moment ago: bound, then released.
    const probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, "127.0.0.1", resolve);
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });

    const failure = await failureAt(port);

    expect(failure).toMatchObject({
      code: "ESOCKET",
      originalCode: "ECONNREFUSED",
      handover: "not-handed-over",
    });
    expect(mayHaveBeenHandedOver(failure)).toBe(false);
  });

  it("says a message refused at its end was not handed over", async () => {
    const failure = await failureAt(
      await listen({ greeting: true, afterData: "refuse" }),
    );

    expect(failure).toMatchObject({
      code: "EMESSAGE",
      handover: "not-handed-over",
    });
    expect(mayHaveBeenHandedOver(failure)).toBe(false);
  });

  it("says a server that hangs up after the end of the message may have taken it", async () => {
    const failure = await failureAt(
      await listen({ greeting: true, afterData: "hang-up" }),
    );

    // The message was sent in full and its answer never came, so the server
    // may have queued it. Whatever code nodemailer gives the lost connection,
    // it is not one that places the failure before the send.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ handover: "may-have-been-handed-over" });
    expect(mayHaveBeenHandedOver(failure)).toBe(true);
  });

  it("says a server that never greets was not handed over", async () => {
    const failure = await failureAt(
      await listen({ greeting: false, afterData: "accept" }),
      { greetingTimeoutMs: 200 },
    );

    expect(failure).toMatchObject({
      code: "ETIMEDOUT",
      timeoutType: "GREETING_TIMEOUT",
      handover: "not-handed-over",
    });
    expect(mayHaveBeenHandedOver(failure)).toBe(false);
  });

  it("resolves for the same server when it accepts the message", async () => {
    // The control case: the failures above are about what the server did at
    // each point, not about a server these cases cannot talk to.
    const port = await listen({ greeting: true, afterData: "accept" });
    const driver = new SmtpMailDriver({
      host: "127.0.0.1",
      port,
      secure: false,
      requireTls: false,
      user: null,
      password: null,
      allowPrivateHosts: true,
    });
    drivers.push(driver);

    await expect(driver.send(MAIL)).resolves.toBeDefined();
  });
});

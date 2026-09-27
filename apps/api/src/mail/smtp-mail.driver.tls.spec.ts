import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OutgoingMail } from "./mail-driver";
import { SmtpMailDriver } from "./smtp-mail.driver";

/**
 * Whether the password can be sent in the clear.
 *
 * Against a real SMTP conversation rather than the transport double the other
 * driver suite uses, because the property is what reaches the wire: an attacker
 * on the path who strips STARTTLS from the server's greeting leaves exactly the
 * server below, one that offers AUTH and no upgrade. A double would only show
 * which option was passed, not what nodemailer does with it.
 */

/** Every line the server received, in order. */
let received: string[] = [];
let server: Server;
let port: number;

/** A submission server that offers AUTH and never STARTTLS. */
function answer(socket: Socket): void {
  socket.setEncoding("utf8");
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
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write("250 queued\r\n");
        }
        continue;
      }
      received.push(line);
      const verb = line.split(" ")[0]?.toUpperCase() ?? "";
      if (verb === "EHLO") {
        socket.write("250-relay.test\r\n250 AUTH PLAIN LOGIN\r\n");
      } else if (verb === "STARTTLS") {
        // What a server that never offered it answers when asked anyway.
        socket.write("502 command not implemented\r\n");
      } else if (verb === "AUTH") {
        socket.write("235 accepted\r\n");
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
  socket.on("error", () => {
    // The client hanging up mid-conversation is one of the cases under test.
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
});

const MAIL: OutgoingMail = {
  from: { name: null, address: "utskick@delad.example" },
  to: "anna@exempel.se",
  subject: "Ett konto väntar på dig",
  html: "<p>Aktivera ditt konto</p>",
  text: "Aktivera ditt konto",
  replyTo: null,
  messageId: null,
  inReplyTo: null,
};

function driver(requireTls: boolean): SmtpMailDriver {
  return new SmtpMailDriver({
    host: "127.0.0.1",
    port,
    secure: false,
    requireTls,
    user: "relay",
    password: "relay-password",
  });
}

describe("a relay that offers no STARTTLS", () => {
  it("is refused before the password is sent, when TLS is required", async () => {
    const smtp = driver(true);

    await expect(smtp.send(MAIL)).rejects.toThrow();
    smtp.close();

    expect(received.some((line) => /^EHLO /i.test(line))).toBe(true);
    expect(received.some((line) => /^AUTH /i.test(line))).toBe(false);
  });

  it("receives the password in the clear otherwise, which is what the flag prevents", async () => {
    // The control case: the same server does see AUTH when nothing requires
    // TLS, so the assertion above is about the flag and not about the server.
    const smtp = driver(false);

    await smtp.send(MAIL);
    smtp.close();

    expect(received.some((line) => /^AUTH /i.test(line))).toBe(true);
  });
});

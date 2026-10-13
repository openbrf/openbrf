import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ResolveAddresses,
  ResolvedAddress,
} from "../network/outbound-address";
import type { OutgoingMail } from "./mail-driver";
import { MailServerNotPublicError, SmtpMailDriver } from "./smtp-mail.driver";

/**
 * What a send is allowed to cost when the far end goes quiet.
 *
 * Every send in this application is awaited by whatever triggered it, and the
 * callers that send after committing their work - a move, a booking - catch the
 * failure and carry on. That only holds if a send fails: a transport left on its
 * own defaults waits two minutes to connect and ten on an idle socket, and for
 * that whole time the caller is holding an open request rather than running its
 * catch block. So the bound is stated on the transport, where it covers every
 * path at once, rather than in each caller.
 *
 * The transport is a double here because the property is which options it is
 * built with. A real stall would need a socket that accepts and never answers,
 * and a test that waits out the timeout to prove the timeout exists.
 */

const transport = vi.hoisted(() => {
  const sendMail = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  return {
    sendMail,
    close,
    createTransport: vi.fn((_options: Record<string, unknown>) => ({
      sendMail,
      close,
    })),
  };
});

vi.mock("nodemailer", () => ({
  createTransport: transport.createTransport,
}));

const SERVER = {
  host: "smtp.exempel.se",
  port: 587,
  secure: false,
  requireTls: false,
  user: null,
  password: null,
  allowPrivateHosts: true,
};

const MAIL: OutgoingMail = {
  from: { name: null, address: "brf@exempel.se" },
  to: "anna@exempel.se",
  subject: "Ett konto väntar på dig",
  html: "<p>Aktivera ditt konto</p>",
  text: "Aktivera ditt konto",
  replyTo: null,
  messageId: null,
  inReplyTo: null,
};

beforeEach(() => {
  transport.createTransport.mockClear();
  transport.close.mockClear();
  transport.sendMail.mockClear();
  transport.sendMail.mockResolvedValue(undefined);
});

describe("the mail transport", () => {
  it("is built with a bound on every stage a mail server can stall at", async () => {
    const driver = new SmtpMailDriver(SERVER);

    await driver.send(MAIL);

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    // All three, because a server can go quiet at three different points: the
    // TCP connect, the greeting after it, and any exchange on the open socket.
    // Bounding one of the three leaves the other two unbounded.
    expect(transport.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: expect.any(Number),
        greetingTimeout: expect.any(Number),
        socketTimeout: expect.any(Number),
      }),
    );

    const bounds = transport.createTransport.mock.calls[0]?.[0] ?? {};
    for (const stage of [
      "connectionTimeout",
      "greetingTimeout",
      "socketTimeout",
    ]) {
      // Short enough that the caller holding the request gets its answer, and
      // in particular shorter than the defaults this replaces. A missing bound
      // reads as NaN here and fails both comparisons.
      expect(Number(bounds[stage])).toBeGreaterThan(0);
      expect(Number(bounds[stage])).toBeLessThanOrEqual(30_000);
    }
  });

  it("lets a refusal reach the caller, which is what the bound is for", async () => {
    const driver = new SmtpMailDriver(SERVER);
    transport.sendMail.mockRejectedValue(new Error("connection timed out"));

    // The callers that send after committing their work catch this and log it.
    // A send that never settled would never reach them.
    await expect(driver.send(MAIL)).rejects.toThrow("connection timed out");
  });
});

describe("the message handed to the server", () => {
  it("passes a bare sender as it always has", async () => {
    await new SmtpMailDriver(SERVER).send(MAIL);

    expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: "brf@exempel.se",
    });
  });

  it("passes a display name for nodemailer to encode", async () => {
    // Not written into a string here: a name with a letter outside ASCII or a
    // quote in it has to be encoded, and nodemailer does that from the parts.
    await new SmtpMailDriver(SERVER).send({
      ...MAIL,
      from: { name: 'Brf "Åkern" 1', address: "utskick@delad.example" },
    });

    expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: { name: 'Brf "Åkern" 1', address: "utskick@delad.example" },
    });
  });

  it("writes both threading headers from the answered identifier", async () => {
    await new SmtpMailDriver(SERVER).send({
      ...MAIL,
      messageId: "svar-1@styrelsen.example",
      inReplyTo: "fraga-1@utanfor.example",
    });

    expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
      messageId: "<svar-1@styrelsen.example>",
      inReplyTo: "<fraga-1@utanfor.example>",
      references: ["<fraga-1@utanfor.example>"],
    });
  });
});

describe("the identifier it reports", () => {
  it("is the one it was given, which an SMTP server does not rewrite", async () => {
    transport.sendMail.mockResolvedValue({ messageId: "<other@relay>" });

    const sent = await new SmtpMailDriver(SERVER).send({
      ...MAIL,
      messageId: "svar-1@styrelsen.example",
    });

    expect(sent).toEqual({ messageId: "svar-1@styrelsen.example" });
  });

  it("is nodemailer's own, without brackets, when none was given", async () => {
    transport.sendMail.mockResolvedValue({
      messageId: "<abc-123@exempel.se>",
    });

    const sent = await new SmtpMailDriver(SERVER).send(MAIL);

    expect(sent).toEqual({ messageId: "abc-123@exempel.se" });
  });

  it("is none when neither was there", async () => {
    const sent = await new SmtpMailDriver(SERVER).send(MAIL);

    expect(sent).toEqual({ messageId: null });
  });
});

describe("a server the board entered", () => {
  /** The board's server, held to public addresses, over a stub resolver. */
  function checked(
    host: string,
    ...answers: ResolvedAddress[]
  ): { driver: SmtpMailDriver; resolve: ReturnType<typeof vi.fn> } {
    const resolve = vi.fn<ResolveAddresses>(() => Promise.resolve(answers));
    return {
      driver: new SmtpMailDriver(
        { ...SERVER, host, allowPrivateHosts: false },
        resolve,
      ),
      resolve,
    };
  }

  it("is refused when its name resolves somewhere private, and nothing is sent", async () => {
    const { driver } = checked("smtp.exempel.se", {
      address: "10.0.0.5",
      family: 4,
    });

    await expect(driver.send(MAIL)).rejects.toBeInstanceOf(
      MailServerNotPublicError,
    );
    expect(transport.createTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it("is refused when it is the metadata service written as an address", async () => {
    const { driver, resolve } = checked("169.254.169.254");

    await expect(driver.send(MAIL)).rejects.toBeInstanceOf(
      MailServerNotPublicError,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it("is reached at the address that was checked, with its name kept for TLS", async () => {
    const { driver } = checked(
      "smtp.exempel.se",
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    );

    await driver.send(MAIL);

    // The address rather than the name, so nodemailer has nothing left to
    // resolve; the name is what the certificate is checked against.
    expect(transport.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "1.1.1.1",
        servername: "smtp.exempel.se",
        connectionTimeout: expect.any(Number),
      }),
    );
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    // A transport built for one send is closed after it.
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("is resolved again at every send", async () => {
    const { driver, resolve } = checked("smtp.exempel.se", {
      address: "1.1.1.1",
      family: 4,
    });

    await driver.send(MAIL);
    resolve.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

    // A name that moved after it was saved is refused at the send.
    await expect(driver.send(MAIL)).rejects.toBeInstanceOf(
      MailServerNotPublicError,
    );
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
});

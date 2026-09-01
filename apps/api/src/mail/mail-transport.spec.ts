import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { MailService } from "./mail.service";
import { invitationMail } from "./templates";

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

const TEST_ENV = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgresql://unused",
  APP_URL: "https://brf.example.se",
  OPENBRF_DATA_DIR: "./.data",
  OPENBRF_ENCRYPTION_KEY: "a".repeat(64),
  BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
  OPENBRF_PLUGINS_ENABLED: false,
  OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
} as Env;

/** An association with mail configured, so the send reaches the transport. */
const ASSOCIATION = {
  id: 1,
  name: "Brf Eksemplet",
  primaryColor: "#8A6D28",
  logoFileId: null,
  logoDarkFileId: null,
  smtpHost: "smtp.exempel.se",
  smtpFromAddress: "brf@exempel.se",
  smtpPasswordCipher: null,
  smtpPort: 587,
  smtpUser: null,
  smtpSecure: false,
};

async function buildService(): Promise<MailService> {
  const i18n = new I18nService();
  await i18n.init();
  return new MailService(
    TEST_ENV,
    {
      association: { findUnique: vi.fn().mockResolvedValue(ASSOCIATION) },
    } as unknown as PrismaService,
    i18n,
    { decrypt: vi.fn() } as unknown as FieldEncryptionService,
  );
}

function sendOne(service: MailService): Promise<void> {
  return service.send({
    to: "anna@exempel.se",
    locale: "sv",
    template: invitationMail,
    props: {
      recipientName: "Anna",
      activationUrl: "https://brf.example.se/activate/abc",
      expiresAt: new Date("2026-09-03T10:00:00Z"),
    },
  });
}

beforeEach(() => {
  transport.createTransport.mockClear();
  transport.sendMail.mockClear();
  transport.sendMail.mockResolvedValue(undefined);
});

describe("the mail transport", () => {
  it("is built with a bound on every stage a mail server can stall at", async () => {
    const service = await buildService();

    await sendOne(service);

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
    const service = await buildService();
    transport.sendMail.mockRejectedValue(new Error("connection timed out"));

    // The callers that send after committing their work catch this and log it.
    // A send that never settled would never reach them.
    await expect(sendOne(service)).rejects.toThrow("connection timed out");
  });
});

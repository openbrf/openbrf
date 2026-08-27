import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { MailService } from "./mail.service";
import { invitationMail, magicLinkMail, moveOutMail } from "./templates";

/**
 * Rendering is tested for real (React Email through to HTML and plain text)
 * because the rules under test are about the output: the recipient's language,
 * the plain-text alternative, and the fallback link.
 */

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

const ASSOCIATION = {
  id: 1,
  name: "Brf Eksemplet",
  primaryColor: "#8A6D28",
  logoPath: null,
  smtpHost: null,
  smtpFromAddress: null,
  smtpPasswordCipher: null,
  smtpPort: null,
  smtpUser: null,
  smtpSecure: true,
};

function buildService(): MailService {
  const prisma = {
    association: { findUnique: vi.fn().mockResolvedValue(ASSOCIATION) },
  } as unknown as PrismaService;
  const encryption = {
    decrypt: vi.fn(),
  } as unknown as FieldEncryptionService;

  const i18n = new I18nService();
  // Nest would call onModuleInit; construct it directly here.
  void i18n.init();

  return new MailService(TEST_ENV, prisma, i18n, encryption);
}

describe("MailService rendering", () => {
  let service: MailService;

  beforeAll(async () => {
    const i18n = new I18nService();
    await i18n.init();
    const prisma = {
      association: { findUnique: vi.fn().mockResolvedValue(ASSOCIATION) },
    } as unknown as PrismaService;
    const encryption = {
      decrypt: vi.fn(),
    } as unknown as FieldEncryptionService;
    service = new MailService(TEST_ENV, prisma, i18n, encryption);
  });

  it("renders in the recipient's locale rather than a global default", async () => {
    const swedish = await service.renderMail({
      locale: "sv",
      template: invitationMail,
      props: {
        recipientName: "Anna",
        activationUrl: "https://brf.example.se/activate/abc",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });
    const english = await service.renderMail({
      locale: "en",
      template: invitationMail,
      props: {
        recipientName: "Anna",
        activationUrl: "https://brf.example.se/activate/abc",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });

    expect(swedish.subject).toBe("Ett konto väntar på dig hos Brf Eksemplet");
    expect(english.subject).toBe(
      "You have an account waiting at Brf Eksemplet",
    );
    expect(swedish.html).toContain("Aktivera ditt konto");
    expect(english.html).toContain("Activate your account");
  });

  it("falls back to Swedish for an unsupported recipient locale", async () => {
    const rendered = await service.renderMail({
      locale: "de",
      template: invitationMail,
      props: {
        recipientName: "Anna",
        activationUrl: "https://brf.example.se/activate/abc",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });

    expect(rendered.subject).toBe("Ett konto väntar på dig hos Brf Eksemplet");
  });

  it("sets the document language so screen readers pronounce it correctly", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: invitationMail,
      props: {
        recipientName: "Anna",
        activationUrl: "https://brf.example.se/activate/abc",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });

    expect(rendered.html).toContain('lang="sv"');
  });

  it("always produces a plain-text alternative containing the link", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: magicLinkMail,
      props: {
        recipientName: "Erik",
        signInUrl: "https://brf.example.se/signin/xyz",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });

    // Some clients render only the text part, and this link is how someone
    // signs in, so its absence would be a lockout.
    expect(rendered.text).toContain("https://brf.example.se/signin/xyz");
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it("includes a copyable fallback link beside the button", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: magicLinkMail,
      props: {
        recipientName: "Erik",
        signInUrl: "https://brf.example.se/signin/xyz",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });

    expect(rendered.html).toContain("Om knappen inte fungerar");
    // Once as the button href, once as visible copyable text.
    const occurrences =
      rendered.html.split("https://brf.example.se/signin/xyz").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("formats dates in the recipient's locale", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: invitationMail,
      props: {
        recipientName: "Anna",
        activationUrl: "https://brf.example.se/activate/abc",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });

    // Swedish formatting is year-first.
    expect(rendered.html).toContain("2026-09-03");
  });

  it("states the two-tier retention in the move-out mail", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: moveOutMail,
      props: {
        recipientName: "Karin",
        apartmentNumber: "1201",
        movedOutOn: new Date("2026-08-01T00:00:00Z"),
        purgeOn: new Date("2028-07-31T00:00:00Z"),
      },
    });

    // Telling the resident what is kept and what is erased, unprompted, is
    // part of the transparency the product is positioned on.
    expect(rendered.html).toContain("medlemsförteckningen");
    expect(rendered.html).toContain("2028-07-31");
  });
});

describe("MailService without SMTP", () => {
  it("does not throw outside production, so local flows still work", async () => {
    const service = buildService();

    await expect(
      service.send({
        to: "anna@exempel.se",
        locale: "sv",
        template: invitationMail,
        props: {
          recipientName: "Anna",
          activationUrl: "https://brf.example.se/activate/abc",
          expiresAt: new Date("2026-09-03T10:00:00Z"),
        },
      }),
    ).resolves.toBeUndefined();
  });
});

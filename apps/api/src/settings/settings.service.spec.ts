import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { MailNotConfiguredError, type MailService } from "../mail/mail.service";
import type { MediaService } from "../media/media.service";
import type { I18nService } from "../i18n/i18n.service";
import type { SmsService } from "../sms/sms.service";
import { SettingsService } from "./settings.service";

/**
 * The instance settings, over a fake database and the real field encryption.
 *
 * Two of these behaviours are load-bearing rather than convenient. The SMTP
 * password must never leave this service into a response, because a settings
 * screen that renders a secret back turns every board member's browser session
 * into a way to read it. And a primary colour has to be measured before it is
 * stored, because the trust accent carries legal meaning in the register and a
 * board must not be able to make a statutory document illegible by picking a
 * colour they liked.
 */

const TEST_ENV = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgresql://unused",
  APP_URL: "https://brf.example.se",
  OPENBRF_DATA_DIR: "./.data",
  OPENBRF_ENCRYPTION_KEY: "c".repeat(64),
  BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
  OPENBRF_PLUGINS_ENABLED: false,
  OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
} as Env;

const STORED = {
  id: 1,
  name: "Brf Eksemplet",
  organizationNumber: "769600-1234",
  defaultLocale: "sv",
  logoFileId: null as string | null,
  logo: null as { id: string; fileName: string } | null,
  logoDarkFileId: null as string | null,
  logoDark: null as { id: string; fileName: string } | null,
  primaryColor: null as string | null,
  retentionDaysAfterMoveOut: 365,
  selfSignupEnabled: false,
  issueReportingPublic: true,
  smtpHost: null as string | null,
  smtpPort: null as number | null,
  smtpUser: null as string | null,
  smtpPasswordCipher: null as string | null,
  smtpFromAddress: null as string | null,
  smtpSecure: true,
  smsDriver: null as string | null,
  smsGatewayUrl: null as string | null,
  smsGatewayTokenCipher: null as string | null,
  smsSenderName: null as string | null,
  activeThemeId: null as string | null,
  setupCompletedAt: null as Date | null,
};

type Association = typeof STORED;

interface Fakes {
  service: SettingsService;
  prisma: {
    association: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    person: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  mail: { send: ReturnType<typeof vi.fn> };
  /**
   * The row as it stands after the writes a test made. A getter rather than the
   * row itself, so an assertion cannot read a value captured before the write.
   */
  current: () => Association | null;
  sms: {
    send: ReturnType<typeof vi.fn>;
    isConfigured: ReturnType<typeof vi.fn>;
  };
  i18n: { translatorFor: ReturnType<typeof vi.fn> };
}

function build(overrides: Partial<Association> = {}, exists = true): Fakes {
  let row: Association | null = exists ? { ...STORED, ...overrides } : null;

  const prisma = {
    association: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(
        async (args: {
          create: Partial<Association>;
          update: Partial<Association>;
        }) => {
          row =
            row === null
              ? { ...STORED, ...args.create }
              : { ...row, ...args.update };
          return row;
        },
      ),
      update: vi.fn(async ({ data }: { data: Partial<Association> }) => {
        if (row === null) {
          throw new Error("no association row");
        }
        row = { ...row, ...data };
        return row;
      }),
    },
    person: {
      findUnique: vi.fn(async () => ({
        firstName: "Holger",
        emailCipher: null,
        preferredLocale: "sv",
      })),
      update: vi.fn(async () => ({ preferredLocale: "en" })),
    },
  };

  const mail = { send: vi.fn().mockResolvedValue(undefined) };
  const sms = {
    send: vi.fn().mockResolvedValue(undefined),
    isConfigured: vi.fn().mockResolvedValue(false),
  };
  const i18n = {
    translatorFor: vi.fn(() => (key: string) => key),
  };

  // No logo is uploaded in this suite: these cases are about the SMTP secret
  // and the contrast gate, and the media layer has its own tests.
  const media = { upload: vi.fn(), remove: vi.fn() };

  const service = new SettingsService(
    prisma as unknown as PrismaService,
    new FieldEncryptionService(TEST_ENV),
    mail as unknown as MailService,
    media as unknown as MediaService,
    sms as unknown as SmsService,
    i18n as unknown as I18nService,
  );

  return { service, prisma, mail, sms, i18n, current: () => row };
}

describe("reading the settings", () => {
  it("never returns the SMTP password, only whether one is stored", async () => {
    const { service } = build({
      smtpHost: "smtp.example.se",
      smtpFromAddress: "styrelsen@exempel.se",
      smtpPasswordCipher: "brf:some-ciphertext",
    });

    const settings = await service.read();

    expect(settings.smtp.passwordSet).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("some-ciphertext");
    expect(Object.keys(settings.smtp)).not.toContain("password");
  });

  it("reports mail as unconfigured until a host and a sender exist", async () => {
    const none = build();
    await expect(none.service.read()).resolves.toMatchObject({
      smtp: { configured: false },
    });

    const halfway = build({ smtpHost: "smtp.example.se" });
    await expect(halfway.service.read()).resolves.toMatchObject({
      smtp: { configured: false },
    });

    const both = build({
      smtpHost: "smtp.example.se",
      smtpFromAddress: "styrelsen@exempel.se",
    });
    await expect(both.service.read()).resolves.toMatchObject({
      smtp: { configured: true },
    });
  });

  it("reads back the stored retention policy", async () => {
    // The stored value, not the schema default: a fake database applies no
    // column defaults, so this test can only speak for what the row holds. The
    // default itself is the migration's business and is asserted there.
    const { service } = build({ retentionDaysAfterMoveOut: 400 });
    await expect(service.read()).resolves.toMatchObject({
      retention: { daysAfterMoveOut: 400 },
    });
  });

  it("fails before the housing cooperative has been created", async () => {
    const { service } = build({}, false);
    await expect(service.read()).rejects.toMatchObject({
      reason: "housing-cooperative-missing",
    });
  });
});

describe("the housing cooperative's profile", () => {
  it("creates the row on the wizard's first save", async () => {
    const { service, current } = build({}, false);

    await service.updateHousingCooperative({
      name: "Brf Eksemplet",
      organizationNumber: "769600-1234",
      defaultLocale: "sv",
    });

    expect(current()?.name).toBe("Brf Eksemplet");
  });

  it("clears the organisation number when it is not given", async () => {
    const { service, current } = build({ organizationNumber: "769600-1234" });

    await service.updateHousingCooperative({
      name: "Brf Eksemplet",
      defaultLocale: "sv",
    });

    expect(current()?.organizationNumber).toBeNull();
  });
});

describe("branding", () => {
  it("stores a colour that measures up, in canonical form", async () => {
    const { service, current } = build();

    const result = await service.updateBranding({ primaryColor: "#7D5F23" });

    expect(result.primaryColor).toBe("#7d5f23");
    expect(current()?.primaryColor).toBe("#7d5f23");
  });

  it("stores the colour the board chose, not the accent derived from it", async () => {
    /*
     * A mid blue that reaches AA only once it is mixed towards the light mode's
     * ink, so the derived accent (#0263e4) and the chosen colour differ - unlike
     * the default theme's own brass, which passes untouched and would let this
     * behaviour regress unnoticed.
     *
     * Storing the derived value would show a colour nobody typed on the way back
     * out, and - because both this service and the client re-derive both mode
     * families from the stored value - would make the dark family that actually
     * gets applied one the contrast check above never measured.
     */
    const { service, current } = build();

    const result = await service.updateBranding({ primaryColor: "#0066EE" });

    expect(result.primaryColor).toBe("#0066ee");
    expect(current()?.primaryColor).toBe("#0066ee");
  });

  it("refuses a colour too pale to read, naming the pair and the ratio", async () => {
    const { service, current } = build();

    await expect(
      service.updateBranding({ primaryColor: "#FFE066" }),
    ).rejects.toMatchObject({ reason: "colour-fails-contrast" });

    // Nothing was written: the gate refuses rather than warning.
    expect(current()?.primaryColor).toBeNull();
  });

  it("carries the measured findings so the screen can explain the refusal", async () => {
    const { service } = build();

    await service.updateBranding({ primaryColor: "#FFE066" }).then(
      () => {
        throw new Error("the pale colour was accepted");
      },
      (error: { findings: { ratio: number | null }[] }) => {
        expect(error.findings.length).toBeGreaterThan(0);
        expect(error.findings[0]?.ratio ?? 99).toBeLessThan(4.5);
      },
    );
  });

  it("refuses a value that is not a colour", async () => {
    const { service } = build();
    await expect(
      service.updateBranding({ primaryColor: "brass" }),
    ).rejects.toMatchObject({ reason: "colour-unreadable" });
  });

  it("clears the override, returning to the theme's own accent", async () => {
    const { service, current } = build({ primaryColor: "#7d5f23" });

    await service.updateBranding({ primaryColor: null });

    expect(current()?.primaryColor).toBeNull();
  });

  it("refuses before the housing cooperative exists", async () => {
    const { service } = build({}, false);
    await expect(
      service.updateBranding({ primaryColor: "#7D5F23" }),
    ).rejects.toMatchObject({ reason: "housing-cooperative-missing" });
  });
});

describe("SMTP settings", () => {
  const filled = {
    host: "smtp.example.se",
    port: 587,
    secure: true,
    user: "styrelsen",
    fromAddress: "styrelsen@exempel.se",
  };

  it("encrypts the password rather than storing it as typed", async () => {
    const { service, current } = build();

    await service.updateSmtp({ ...filled, password: "hunter2hunter2" });

    const cipher = current()?.smtpPasswordCipher;
    expect(cipher).toBeTypeOf("string");
    expect(cipher).not.toContain("hunter2hunter2");
  });

  it("keeps the stored password when the field is omitted", async () => {
    // The screen never shows the password, so saving the rest of the form must
    // not wipe it.
    const { service, current } = build({
      smtpPasswordCipher: "brf:existing-ciphertext",
    });

    await service.updateSmtp(filled);

    expect(current()?.smtpPasswordCipher).toBe("brf:existing-ciphertext");
  });

  it("clears the password when it is explicitly emptied", async () => {
    const { service, current } = build({
      smtpPasswordCipher: "brf:existing-ciphertext",
    });

    await service.updateSmtp({ ...filled, password: null });

    expect(current()?.smtpPasswordCipher).toBeNull();
  });

  it("treats an empty string as clearing it too", async () => {
    const { service, current } = build({
      smtpPasswordCipher: "brf:existing-ciphertext",
    });

    await service.updateSmtp({ ...filled, password: "" });

    expect(current()?.smtpPasswordCipher).toBeNull();
  });
});

describe("the SMTP test message", () => {
  let encryption: FieldEncryptionService;

  beforeEach(() => {
    encryption = new FieldEncryptionService(TEST_ENV);
  });

  it("refuses while the instance has no way to send mail", async () => {
    const { service, mail } = build();

    await expect(service.sendTestMessage("person-1")).rejects.toBeInstanceOf(
      MailNotConfiguredError,
    );
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("sends to the administrator's own address from the register", async () => {
    // Never to an address in the request: an endpoint that mails wherever it is
    // told is a relay, and proving the configuration works only means something
    // if the message reaches a mailbox the person asking already controls.
    const { service, prisma, mail } = build({
      smtpHost: "smtp.example.se",
      smtpFromAddress: "styrelsen@exempel.se",
    });
    const stored = await encryption.encrypt(
      "person.email",
      "holger@exempel.se",
    );
    prisma.person.findUnique.mockResolvedValue({
      firstName: "Holger",
      emailCipher: stored.cipher,
      preferredLocale: "en",
    });

    const result = await service.sendTestMessage("person-1");

    expect(result.sentTo).toBe("holger@exempel.se");
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "holger@exempel.se",
        // The recipient's own locale, not the request's.
        locale: "en",
      }),
    );
  });

  it("says so when the administrator's record has no address", async () => {
    const { service, prisma } = build({
      smtpHost: "smtp.example.se",
      smtpFromAddress: "styrelsen@exempel.se",
    });
    prisma.person.findUnique.mockResolvedValue({
      firstName: "Holger",
      emailCipher: null,
      preferredLocale: "sv",
    });

    await expect(service.sendTestMessage("person-1")).rejects.toMatchObject({
      reason: "no-email",
    });
  });
});

describe("SMS settings", () => {
  it("never returns the gateway credential, only whether one is stored", async () => {
    const { service } = build({
      smsDriver: "http-gateway",
      smsGatewayUrl: "https://gateway.example/send",
      smsGatewayTokenCipher: "brf:some-ciphertext",
    });

    const settings = await service.read();

    expect(settings.sms.tokenSet).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("some-ciphertext");
    expect(Object.keys(settings.sms)).not.toContain("token");
  });

  it("reports SMS as unconfigured until a driver has what it needs", async () => {
    const none = build();
    await expect(none.service.read()).resolves.toMatchObject({
      sms: { configured: false },
    });

    // Named but unusable is reported as unable to send, not as half set up:
    // that is what a member would experience.
    const halfway = build({ smsDriver: "http-gateway" });
    await expect(halfway.service.read()).resolves.toMatchObject({
      sms: { configured: false },
    });

    const both = build({
      smsDriver: "http-gateway",
      smsGatewayUrl: "https://gateway.example/send",
    });
    await expect(both.service.read()).resolves.toMatchObject({
      sms: { configured: true },
    });
  });

  it("stores the credential encrypted and keeps it when the field is left out", async () => {
    const { service, current } = build({
      smsDriver: "http-gateway",
      smsGatewayUrl: "https://gateway.example/send",
    });

    await service.updateSms({
      driver: "http-gateway",
      gatewayUrl: "https://gateway.example/send",
      senderName: "Ekhagen",
      token: "a-gateway-secret",
    });
    const stored = current()?.smsGatewayTokenCipher;
    expect(stored).toBeTypeOf("string");
    expect(stored).not.toContain("a-gateway-secret");

    // Saving the rest of the form must not silently wipe a credential the
    // screen never showed.
    await service.updateSms({
      driver: "http-gateway",
      gatewayUrl: "https://gateway.example/send",
      senderName: "Ekhagen",
    });
    expect(current()?.smsGatewayTokenCipher).toBe(stored);
  });

  it("clears the credential when the field is explicitly emptied", async () => {
    const { service, current } = build({
      smsDriver: "http-gateway",
      smsGatewayUrl: "https://gateway.example/send",
      smsGatewayTokenCipher: "brf:some-ciphertext",
    });

    await service.updateSms({
      driver: "http-gateway",
      gatewayUrl: "https://gateway.example/send",
      senderName: null,
      token: null,
    });

    expect(current()?.smsGatewayTokenCipher).toBeNull();
  });
});

describe("the SMS test message", () => {
  it("refuses before a provider is set up", async () => {
    const { service, sms } = build();

    await expect(service.sendTestSms("person-1")).rejects.toMatchObject({
      name: "SmsNotConfiguredError",
    });
    expect(sms.send).not.toHaveBeenCalled();
  });

  it("texts the number as a gateway needs it, in the recipient's language", async () => {
    const { service, prisma, sms, i18n } = build({
      smsDriver: "http-gateway",
      smsGatewayUrl: "https://gateway.example/send",
    });
    const stored = await new FieldEncryptionService(TEST_ENV).encrypt(
      "person.phone",
      "070-123 45 67",
    );
    prisma.person.findUnique.mockResolvedValue({
      firstName: "Holger",
      phoneCipher: stored.cipher,
      preferredLocale: "sv",
    });

    await expect(service.sendTestSms("person-1")).resolves.toEqual({
      sentTo: "+46701234567",
    });

    /*
     * The whole message, not a part of it. `to` is normalized because
     * SmsMessage.to is E.164 and a gateway handed the register's spacing would
     * refuse it or send it somewhere else; `body` is asserted because a
     * regression handing over an English literal would still have called the
     * translator, and this case exists to catch exactly that. The suite's
     * translator returns the key it was given, so the key is the body.
     */
    expect(sms.send).toHaveBeenCalledWith({
      to: "+46701234567",
      body: "sms.test.body",
    });
    // The recipient's own language, never the acting session's: the person
    // reading the message is the one whose locale it is written in.
    expect(i18n.translatorFor).toHaveBeenCalledWith("sv");
  });

  it("refuses when the administrator's own record has no number", async () => {
    const { service, prisma, sms } = build({
      smsDriver: "http-gateway",
      smsGatewayUrl: "https://gateway.example/send",
    });
    prisma.person.findUnique.mockResolvedValue({
      firstName: "Holger",
      phoneCipher: null,
      preferredLocale: "sv",
    });

    await expect(service.sendTestSms("person-1")).rejects.toMatchObject({
      reason: "no-phone",
    });
    expect(sms.send).not.toHaveBeenCalled();
  });
});

describe("retention and self-signup", () => {
  it("stores the retention policy", async () => {
    const { service, current } = build();

    await expect(
      service.updateRetention({ daysAfterMoveOut: 730 }),
    ).resolves.toEqual({ daysAfterMoveOut: 730 });
    expect(current()?.retentionDaysAfterMoveOut).toBe(730);
  });

  it("keeps self-signup off unless it is turned on deliberately", async () => {
    const { service, current } = build();

    expect(current()?.selfSignupEnabled).toBe(false);
    await service.updateSelfSignup({ enabled: true });
    expect(current()?.selfSignupEnabled).toBe(true);
  });

  /*
   * The opposite default to self-signup, deliberately. A sign-up request asks
   * for an account on an instance holding a statutory register; an issue report
   * produces a maintenance ticket. A board that would rather take issues only
   * from its own residents switches this off, and the form then stops existing.
   */
  it("takes issue reports from the public until a board says otherwise", async () => {
    const { service, current } = build();

    await expect(service.read()).resolves.toMatchObject({
      issueReporting: { publicFormEnabled: true },
    });

    await expect(
      service.updateIssueReporting({ publicFormEnabled: false }),
    ).resolves.toEqual({ publicFormEnabled: false });
    expect(current()?.issueReportingPublic).toBe(false);
  });

  it("refuses all three before the housing cooperative exists", async () => {
    const { service } = build({}, false);

    await expect(
      service.updateRetention({ daysAfterMoveOut: 730 }),
    ).rejects.toMatchObject({ reason: "housing-cooperative-missing" });
    await expect(
      service.updateSelfSignup({ enabled: true }),
    ).rejects.toMatchObject({ reason: "housing-cooperative-missing" });
    await expect(
      service.updateIssueReporting({ publicFormEnabled: true }),
    ).rejects.toMatchObject({ reason: "housing-cooperative-missing" });
  });
});

describe("a person's own profile", () => {
  it("updates the locale of the person the session names", async () => {
    const { service, prisma } = build();

    await expect(
      service.updateOwnProfile("person-1", { preferredLocale: "en" }),
    ).resolves.toEqual({ preferredLocale: "en" });
    expect(prisma.person.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "person-1" } }),
    );
  });

  it("reports a missing person rather than failing opaquely", async () => {
    const { service, prisma } = build();
    prisma.person.update.mockRejectedValue(new Error("record not found"));

    await expect(
      service.updateOwnProfile("ghost", { preferredLocale: "en" }),
    ).rejects.toMatchObject({ reason: "person-not-found" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { MailSettingsResolver } from "../mail/mail-settings";
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
  OPENBRF_MAIL_DRIVER: "settings",
} as Env;

/** Mail set where the instance runs, through an HTTP mail API (ADR 0024). */
const HTTP_API_ENV = {
  ...TEST_ENV,
  OPENBRF_MAIL_DRIVER: "http-api",
  OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
  OPENBRF_MAIL_API_URL: "https://api.mail.example/v1",
  OPENBRF_MAIL_API_KEY: "key-from-the-environment",
  OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "mail.example",
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
  boardMailboxAddress: null as string | null,
  boardMailboxPop3Host: null as string | null,
  boardMailboxPop3Port: null as number | null,
  boardMailboxPop3Secure: true,
  boardMailboxPop3User: null as string | null,
  boardMailboxPop3PasswordCipher: null as string | null,
  smsDriver: null as string | null,
  smsGatewayUrl: null as string | null,
  smsGatewayTokenCipher: null as string | null,
  smsSenderName: null as string | null,
  activeThemeId: null as string | null,
  setupCompletedAt: null as Date | null,
  financialYearStartMonth: 1,
  bankgiro: null as string | null,
  plusgiro: null as string | null,
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
  /** The log. The finance and data protection contacts writes reach it. */
  audit: { record: ReturnType<typeof vi.fn> };
}

function build(
  overrides: Partial<Association> = {},
  exists = true,
  env: Env = TEST_ENV,
): Fakes {
  let row: Association | null = exists ? { ...STORED, ...overrides } : null;

  const prisma = {
    association: {
      findUnique: vi.fn(async () => row),
      findUniqueOrThrow: vi.fn(async () => {
        if (row === null) {
          throw new Error("no association row");
        }
        return row;
      }),
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
    /*
     * The audited writes run inside a transaction. The fake hands itself back,
     * so a write and the audit entry beside it see the one mutable row this
     * suite keeps - which is what the real transaction gives them too.
     */
    $transaction: vi.fn(
      async <T>(run: (tx: unknown) => Promise<T>): Promise<T> =>
        run(transactionClient),
    ),
  };

  const transactionClient = prisma;

  const mail = { send: vi.fn().mockResolvedValue({ messageId: null }) };
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
  const audit = { record: vi.fn(async () => undefined) };

  const encryption = new FieldEncryptionService(TEST_ENV);
  const service = new SettingsService(
    prisma as unknown as PrismaService,
    encryption,
    mail as unknown as MailService,
    media as unknown as MediaService,
    sms as unknown as SmsService,
    i18n as unknown as I18nService,
    audit as never,
    new MailSettingsResolver(
      env,
      prisma as unknown as PrismaService,
      encryption,
    ),
  );

  return { service, prisma, mail, sms, i18n, audit, current: () => row };
}

describe("reading the settings", () => {
  it("never returns the SMTP password, only whether one is stored", async () => {
    const { service } = build({
      smtpHost: "smtp.example.se",
      smtpFromAddress: "styrelsen@exempel.se",
      smtpPasswordCipher: "brf:some-ciphertext",
    });

    const settings = await service.read();

    expect(settings.smtp).toMatchObject({
      source: "settings",
      passwordSet: true,
    });
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

  it("logs whether a sender is set, never the address", async () => {
    // Often a board member's own address, and a log keeps what it is given
    // (ADR 0007).
    const { service } = build();
    const logged: string[] = [];
    vi.spyOn(
      (service as unknown as { logger: { log: (line: string) => void } })
        .logger,
      "log",
    ).mockImplementation((line: string) => {
      logged.push(line);
    });

    await service.updateSmtp(filled);

    expect(logged.join("\n")).not.toContain("styrelsen@exempel.se");
  });

  it("keeps the stored password when the field is omitted", async () => {
    // The screen never shows the password, so saving the rest of the form must
    // not wipe it.
    const { service, current } = build({
      smtpHost: filled.host,
      smtpPort: filled.port,
      smtpPasswordCipher: "brf:existing-ciphertext",
    });

    await service.updateSmtp({ ...filled, user: "kassoren" });

    expect(current()?.smtpPasswordCipher).toBe("brf:existing-ciphertext");
    expect(current()?.smtpUser).toBe("kassoren");
  });

  it.each([
    ["host", { host: "smtp.elsewhere.example" }],
    ["port", { port: 2525 }],
  ])(
    "refuses to keep the stored password for a new %s, and writes nothing",
    async (_, change) => {
      // The next send would hand the association's password to whatever
      // answers at the new address.
      const { service, current } = build({
        smtpHost: filled.host,
        smtpPort: filled.port,
        smtpPasswordCipher: "brf:existing-ciphertext",
      });

      await expect(
        service.updateSmtp({ ...filled, ...change }),
      ).rejects.toMatchObject({
        reason: "secret-required-for-new-endpoint",
        status: 400,
      });
      expect(current()).toMatchObject({
        smtpHost: filled.host,
        smtpPort: filled.port,
        smtpPasswordCipher: "brf:existing-ciphertext",
      });
    },
  );

  it("takes a new host together with a new or a cleared password", async () => {
    const stored = {
      smtpHost: filled.host,
      smtpPort: filled.port,
      smtpPasswordCipher: "brf:existing-ciphertext",
    };
    const moved = { ...filled, host: "smtp.elsewhere.example" };

    const replaced = build(stored);
    await replaced.service.updateSmtp({ ...moved, password: "new-password" });
    expect(replaced.current()?.smtpHost).toBe("smtp.elsewhere.example");
    expect(replaced.current()?.smtpPasswordCipher).not.toBe(
      "brf:existing-ciphertext",
    );

    const cleared = build(stored);
    await cleared.service.updateSmtp({ ...moved, password: null });
    expect(cleared.current()).toMatchObject({
      smtpHost: "smtp.elsewhere.example",
      smtpPasswordCipher: null,
    });
  });

  it("takes a new host freely while no password is stored", async () => {
    const { service, current } = build({ smtpHost: "smtp.old.example" });

    await service.updateSmtp(filled);

    expect(current()?.smtpHost).toBe(filled.host);
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

describe("mail set where the instance runs", () => {
  /** What the board stored before the environment said anything. */
  const storedByTheBoard = {
    smtpHost: "smtp.stored.example",
    smtpPort: 2525,
    smtpUser: "styrelsen",
    smtpPasswordCipher: "brf:stored-ciphertext",
    smtpFromAddress: "styrelsen@eksemplet.example",
  };

  it("is what the settings show, with no user or password fields", async () => {
    const { service } = build(storedByTheBoard, true, HTTP_API_ENV);

    const settings = await service.read();

    // The service mail goes through and the sender, and nothing the board
    // could take for something it may change.
    expect(settings.smtp).toEqual({
      source: "environment",
      host: "api.mail.example",
      fromAddress: "utskick@delad.example",
      configured: true,
    });
    expect(JSON.stringify(settings.smtp)).not.toContain("smtp.stored.example");
  });

  it("refuses the board's SMTP settings with a conflict, and writes nothing", async () => {
    const { service, prisma, current } = build(
      storedByTheBoard,
      true,
      HTTP_API_ENV,
    );

    const refusal = await service
      .updateSmtp({
        host: "smtp.other.example",
        port: 587,
        secure: false,
        user: null,
        password: null,
        fromAddress: "annan@eksemplet.example",
      })
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      status: 409,
      reason: "mail-managed-by-environment",
    });
    expect(prisma.association.update).not.toHaveBeenCalled();
    // The stored settings stay, to apply again if the environment is unset.
    expect(current()).toMatchObject(storedByTheBoard);
  });

  it("shows the stored settings again once the environment sets nothing", async () => {
    const { service } = build(storedByTheBoard);

    expect((await service.read()).smtp).toMatchObject({
      source: "settings",
      host: "smtp.stored.example",
      port: 2525,
      passwordSet: true,
    });
  });

  it("sends the test message through the mail service, naming the host", async () => {
    const { service, prisma, mail } = build({}, true, HTTP_API_ENV);
    const encryption = new FieldEncryptionService(TEST_ENV);
    const stored = await encryption.encrypt(
      "person.email",
      "holger@exempel.se",
    );
    prisma.person.findUnique.mockResolvedValue({
      firstName: "Holger",
      emailCipher: stored.cipher,
      preferredLocale: "sv",
    });

    const result = await service.sendTestMessage("person-1");

    expect(result).toEqual({
      sentTo: "holger@exempel.se",
      host: "api.mail.example",
    });
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "holger@exempel.se",
        props: { recipientName: "Holger", smtpHost: "api.mail.example" },
      }),
    );
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

  it.each([
    ["gateway address", { gatewayUrl: "https://elsewhere.example/send" }],
    ["driver", { driver: "another-driver" }],
  ])(
    "refuses to keep the stored credential for a new %s",
    async (_, change) => {
      const { service, current } = build({
        smsDriver: "http-gateway",
        smsGatewayUrl: "https://gateway.example/send",
        smsGatewayTokenCipher: "brf:some-ciphertext",
      });
      const input = {
        driver: "http-gateway",
        gatewayUrl: "https://gateway.example/send",
        senderName: null,
        ...change,
      };

      await expect(service.updateSms(input)).rejects.toMatchObject({
        reason: "secret-required-for-new-endpoint",
      });
      expect(current()?.smsGatewayUrl).toBe("https://gateway.example/send");

      // Typed again, or cleared, the same change goes through.
      await expect(
        service.updateSms({ ...input, token: null }),
      ).resolves.toMatchObject({ ...change, tokenSet: false });
    },
  );
});

describe("board mailbox settings", () => {
  const filled = {
    address: "styrelsen@exempel.se",
    host: "pop.example.se",
    port: 995,
    secure: true,
    user: "styrelsen",
  };
  const stored = {
    boardMailboxPop3Host: filled.host,
    boardMailboxPop3Port: filled.port,
    boardMailboxPop3PasswordCipher: "brf:existing-ciphertext",
  };

  it("keeps the stored password while the server stays the same", async () => {
    const { service, current } = build(stored);

    await service.updateBoardMailbox({ ...filled, user: "kassoren" });

    expect(current()).toMatchObject({
      boardMailboxPop3User: "kassoren",
      boardMailboxPop3PasswordCipher: "brf:existing-ciphertext",
    });
  });

  it.each([
    ["host", { host: "pop.elsewhere.example" }],
    ["port", { port: 1110 }],
  ])("refuses to keep the stored password for a new %s", async (_, change) => {
    const { service, current } = build(stored);

    await expect(
      service.updateBoardMailbox({ ...filled, ...change }),
    ).rejects.toMatchObject({ reason: "secret-required-for-new-endpoint" });
    expect(current()).toMatchObject(stored);

    await service.updateBoardMailbox({
      ...filled,
      ...change,
      password: "new-password",
    });
    expect(current()?.boardMailboxPop3PasswordCipher).not.toBe(
      stored.boardMailboxPop3PasswordCipher,
    );
  });

  it("takes a new host together with a cleared password", async () => {
    const { service, current } = build(stored);

    await service.updateBoardMailbox({
      ...filled,
      host: "pop.elsewhere.example",
      password: "",
    });

    expect(current()).toMatchObject({
      boardMailboxPop3Host: "pop.elsewhere.example",
      boardMailboxPop3PasswordCipher: null,
    });
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

describe("the financial year and the giro numbers", () => {
  it("defaults to the calendar year", async () => {
    // The default every instance recorded before the column existed had
    // assumed, and the value on which both retention windows compute exactly
    // the dates they computed before.
    const { service } = build();

    await expect(service.read()).resolves.toMatchObject({
      finances: { financialYearStartMonth: 1, bankgiro: null, plusgiro: null },
    });
  });

  it("stores a broken financial year and where the association is paid", async () => {
    const { service, current, audit } = build();

    await expect(
      service.updateFinances({
        actorPersonId: "person-1",
        financialYearStartMonth: 5,
        bankgiro: "123-4567",
        plusgiro: null,
      }),
    ).resolves.toEqual({
      financialYearStartMonth: 5,
      bankgiro: "123-4567",
      plusgiro: null,
    });
    expect(current()?.financialYearStartMonth).toBe(5);
    expect(current()?.bankgiro).toBe("123-4567");

    /*
     * Recorded, by whom, and naming the fields that moved and never their
     * values: the month decides the erasure dates of everything written after
     * it, and a giro number corrected later would otherwise stand in a table
     * nobody can amend. The plusgiro did not move, so it is not named.
     */
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ASSOCIATION_FINANCES_RECORDED",
        channel: "WEB",
        actorPersonId: "person-1",
        targetKind: "association",
        context: { fields: ["financialYearStartMonth", "bankgiro"] },
      }),
      expect.anything(),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("123-4567");
  });

  it("writes nothing to the log for a refused write", async () => {
    const { service, audit } = build();

    await expect(
      service.updateFinances({
        actorPersonId: "person-1",
        financialYearStartMonth: 13,
        bankgiro: null,
        plusgiro: null,
      }),
    ).rejects.toMatchObject({ reason: "financial-year-start-not-a-month" });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a month no year has", async () => {
    const { service } = build();

    for (const financialYearStartMonth of [0, 13]) {
      await expect(
        service.updateFinances({
          actorPersonId: "person-1",
          financialYearStartMonth,
          bankgiro: null,
          plusgiro: null,
        }),
      ).rejects.toMatchObject({ reason: "financial-year-start-not-a-month" });
    }
  });

  it("refuses text that is not a giro number", async () => {
    const { service } = build();

    for (const bankgiro of ["inte ett nummer", "12/34567", "1"]) {
      await expect(
        service.updateFinances({
          actorPersonId: "person-1",
          financialYearStartMonth: 1,
          bankgiro,
          plusgiro: null,
        }),
      ).rejects.toMatchObject({ reason: "giro-not-a-number" });
    }
  });

  it("keeps the number the way the board wrote it", async () => {
    // Never reformatted: a board writes the number the way its own bank prints
    // it, and a platform that moved the hyphen would print something the member
    // could not match against their statement.
    const { service, current } = build();

    await service.updateFinances({
      actorPersonId: "person-1",
      financialYearStartMonth: 1,
      bankgiro: "1234567",
      plusgiro: "12 34 56-7".replaceAll(" ", ""),
    });
    expect(current()?.bankgiro).toBe("1234567");
    expect(current()?.plusgiro).toBe("123456-7");
  });

  it("clears rather than stores an empty giro number", async () => {
    const { service, current } = build({ bankgiro: "123-4567" });

    await service.updateFinances({
      actorPersonId: "person-1",
      financialYearStartMonth: 1,
      bankgiro: "",
      plusgiro: null,
    });
    expect(current()?.bankgiro).toBeNull();
  });

  it("refuses before the housing cooperative exists", async () => {
    const { service } = build({}, false);

    await expect(
      service.updateFinances({
        actorPersonId: "person-1",
        financialYearStartMonth: 1,
        bankgiro: null,
        plusgiro: null,
      }),
    ).rejects.toMatchObject({ reason: "housing-cooperative-missing" });
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

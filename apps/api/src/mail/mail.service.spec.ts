import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { MailSettingsResolver } from "./mail-settings";
import { MailService } from "./mail.service";
import {
  startMailApiTestServer,
  type MailApiTestServer,
} from "./testing/mail-api-test-server";
import {
  boardMailboxReplyMail,
  invitationMail,
  magicLinkMail,
  moveOutMail,
} from "./templates";

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
  OPENBRF_MAIL_DRIVER: "settings",
} as Env;

const ASSOCIATION = {
  id: 1,
  name: "Brf Eksemplet",
  primaryColor: "#8A6D28",
  logoFileId: null,
  logoDarkFileId: null,
  smtpHost: null,
  smtpFromAddress: null,
  smtpPasswordCipher: null,
  smtpPort: null,
  smtpUser: null,
  smtpSecure: true,
};

/**
 * A mail service over a database holding `association`, and the environment
 * `env`, with the real resolver between them.
 */
function serviceWith(
  env: Env,
  association: object | null,
  i18n: I18nService,
): MailService {
  const prisma = {
    association: { findUnique: vi.fn().mockResolvedValue(association) },
  } as unknown as PrismaService;
  const encryption = {
    decrypt: vi.fn().mockResolvedValue("stored-password"),
  } as unknown as FieldEncryptionService;
  return new MailService(
    env,
    prisma,
    i18n,
    new MailSettingsResolver(env, prisma, encryption),
  );
}

function buildService(): MailService {
  const i18n = new I18nService();
  // Nest would call onModuleInit; construct it directly here.
  void i18n.init();

  return serviceWith(TEST_ENV, ASSOCIATION, i18n);
}

describe("MailService rendering", () => {
  let service: MailService;

  beforeAll(async () => {
    const i18n = new I18nService();
    await i18n.init();
    service = serviceWith(TEST_ENV, ASSOCIATION, i18n);
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

describe("the logo in a message", () => {
  async function renderWith(logoFileId: string | null): Promise<string> {
    const i18n = new I18nService();
    await i18n.init();
    const service = serviceWith(TEST_ENV, { ...ASSOCIATION, logoFileId }, i18n);

    const rendered = await service.renderMail({
      locale: "sv",
      template: invitationMail,
      props: {
        recipientName: "Anna",
        activationUrl: "https://brf.example.se/activate/abc",
        expiresAt: new Date("2026-09-03T10:00:00Z"),
      },
    });
    return rendered.html;
  }

  it("points at the association's own origin, never at storage", async () => {
    /*
     * A mail client fetches this URL directly, from whatever network the
     * recipient is on. Pointing it at a bucket would disclose to the storage
     * provider that this person opened this message and when - which is the
     * same reason the platform serves the file itself rather than redirecting.
     */
    const html = await renderWith("file-1");

    expect(html).toContain("https://brf.example.se/api/media/file-1");
  });

  it("shows no mark at all until one is uploaded", async () => {
    const html = await renderWith(null);

    expect(html).not.toContain("/api/media/");
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
    ).resolves.toEqual({ messageId: null });
  });
});

/*
 * Where a message goes, and what it goes out as.
 *
 * The SMTP transport is a double, for the reason smtp-mail.driver.spec.ts gives;
 * the mail API is the in-process test server, so a message sent through it is a
 * real HTTP conversation.
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

/** A board that stored its own server, and configured its mailbox. */
const STORED = {
  ...ASSOCIATION,
  smtpHost: "smtp.stored.example",
  smtpFromAddress: "styrelsen@eksemplet.example",
  smtpPort: 587,
  smtpSecure: false,
  boardMailboxAddress: "styrelsen@eksemplet.example",
  boardMailboxPop3Host: "pop.eksemplet.example",
  boardMailboxPop3User: "styrelsen",
  boardMailboxPop3PasswordCipher: "brf:mailbox-ciphertext",
};

/** The same association with no board mailbox configured. */
const NO_MAILBOX = {
  ...STORED,
  boardMailboxAddress: null,
  boardMailboxPop3Host: null,
  boardMailboxPop3User: null,
  boardMailboxPop3PasswordCipher: null,
};

let api: MailApiTestServer;
let i18n: I18nService;

beforeAll(async () => {
  api = await startMailApiTestServer();
  i18n = new I18nService();
  await i18n.init();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  transport.createTransport.mockClear();
  transport.sendMail.mockClear();
  transport.close.mockClear();
  transport.sendMail.mockResolvedValue(undefined);
});

function httpApiEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...TEST_ENV,
    OPENBRF_MAIL_DRIVER: "http-api",
    OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
    OPENBRF_MAIL_API_URL: api.baseUrl,
    OPENBRF_MAIL_API_KEY: api.key,
    OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "getpost.se",
    ...overrides,
  };
}

const SMTP_ENV = {
  ...TEST_ENV,
  OPENBRF_MAIL_DRIVER: "smtp",
  OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
  OPENBRF_SMTP_HOST: "smtp.host.example",
} as Env;

function invitation(
  service: MailService,
  extra: { replyTo?: string; messageId?: string } = {},
) {
  return service.send({
    to: "anna@exempel.se",
    locale: "sv",
    template: invitationMail,
    props: {
      recipientName: "Anna",
      activationUrl: "https://brf.example.se/activate/abc",
      expiresAt: new Date("2026-09-03T10:00:00Z"),
    },
    ...extra,
  });
}

/** The last message the mail API accepted. */
function lastAccepted() {
  return api.accepted.at(-1)?.payload;
}

describe("the driver", () => {
  it("is the board's own server while the environment chooses none", async () => {
    await invitation(serviceWith(TEST_ENV, STORED, i18n));

    expect(transport.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.stored.example" }),
    );
  });

  it("is the environment's SMTP server over the one the board stored", async () => {
    await invitation(serviceWith(SMTP_ENV, STORED, i18n));

    expect(transport.createTransport).toHaveBeenCalledTimes(1);
    expect(transport.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.host.example" }),
    );
  });

  it("is the environment's mail API, and nothing goes to the stored server", async () => {
    const before = api.accepted.length;

    await invitation(serviceWith(httpApiEnv(), STORED, i18n));

    expect(api.accepted).toHaveLength(before + 1);
    expect(lastAccepted()?.to).toEqual(["anna@exempel.se"]);
    expect(transport.createTransport).not.toHaveBeenCalled();
  });

  it("reports the identifier the mail API delivered the message with", async () => {
    const sent = await invitation(serviceWith(httpApiEnv(), STORED, i18n), {
      messageId: "svar-1@eksemplet.example",
    });

    expect(sent).toEqual({
      messageId: `${api.accepted.at(-1)?.id ?? ""}@getpost.se`,
    });
  });

  it("is reused while the settings are unchanged, and replaced when they change", async () => {
    let row: object = STORED;
    const prisma = {
      association: { findUnique: vi.fn(async () => row) },
    } as unknown as PrismaService;
    const encryption = {
      decrypt: vi.fn(),
    } as unknown as FieldEncryptionService;
    const service = new MailService(
      TEST_ENV,
      prisma,
      i18n,
      new MailSettingsResolver(TEST_ENV, prisma, encryption),
    );

    await invitation(service);
    await invitation(service);
    expect(transport.createTransport).toHaveBeenCalledTimes(1);

    row = { ...STORED, smtpHost: "smtp.new.example" };
    await invitation(service);
    expect(transport.createTransport).toHaveBeenCalledTimes(2);
    // The transport built for the old settings is closed as it is replaced.
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});

describe("the subject", () => {
  /*
   * An answer's subject quotes the thread's, which an outside sender wrote. A
   * thread collected before the reader kept subjects on one line can still
   * hold a line break, and the mail API writes the subject into the header as
   * it is given.
   */
  function answerTo(service: MailService, subject: string) {
    return service.send({
      to: "anna@exempel.se",
      locale: "sv",
      template: boardMailboxReplyMail,
      props: {
        subject,
        body: "Tack för ditt brev.",
        boardAddress: "styrelsen@eksemplet.example",
      },
    });
  }

  it("reaches the mail API on one line, whatever the thread's held", async () => {
    await answerTo(
      serviceWith(httpApiEnv(), STORED, i18n),
      "Hej\r\nBcc: nagon@annan.example",
    );

    expect(lastAccepted()?.subject).toBe("Sv: Hej Bcc: nagon@annan.example");
  });

  it("reaches the SMTP server on one line too", async () => {
    await answerTo(
      serviceWith(SMTP_ENV, STORED, i18n),
      "Hej\nBcc: x@y.example",
    );

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Sv: Hej Bcc: x@y.example" }),
    );
  });
});

describe("the sender and the Reply-To, when the environment sets the mail", () => {
  it("names the association as the sender of the environment's address", async () => {
    await invitation(serviceWith(httpApiEnv(), STORED, i18n));

    expect(lastAccepted()?.from).toBe(
      '"Brf Eksemplet" <utskick@delad.example>',
    );
  });

  it("uses the configured display name when there is one", async () => {
    await invitation(
      serviceWith(
        httpApiEnv({ OPENBRF_MAIL_FROM_NAME: "Driftad förening" }),
        STORED,
        i18n,
      ),
    );

    expect(lastAccepted()?.from).toBe(
      '"Driftad förening" <utskick@delad.example>',
    );
  });

  it("keeps a registered name on one line", async () => {
    await invitation(
      serviceWith(
        httpApiEnv(),
        { ...STORED, name: "Brf Eksemplet\r\nBcc: nagon@annan.example" },
        i18n,
      ),
    );

    expect(lastAccepted()?.from).toBe(
      '"Brf Eksemplet Bcc: nagon@annan.example" <utskick@delad.example>',
    );
  });

  it("keeps the Reply-To a message names itself", async () => {
    await invitation(
      serviceWith(
        httpApiEnv({ OPENBRF_MAIL_REPLY_TO: "svar@delad.example" }),
        STORED,
        i18n,
      ),
      { replyTo: "egen@eksemplet.example" },
    );

    expect(lastAccepted()?.reply_to).toEqual(["egen@eksemplet.example"]);
  });

  it("directs replies to the configured address before the board mailbox", async () => {
    await invitation(
      serviceWith(
        httpApiEnv({ OPENBRF_MAIL_REPLY_TO: "svar@delad.example" }),
        STORED,
        i18n,
      ),
    );

    expect(lastAccepted()?.reply_to).toEqual(["svar@delad.example"]);
  });

  it("directs replies to the board mailbox when nothing else is configured", async () => {
    await invitation(serviceWith(httpApiEnv(), STORED, i18n));

    expect(lastAccepted()?.reply_to).toEqual(["styrelsen@eksemplet.example"]);
  });

  it("sets no Reply-To when there is no board mailbox either", async () => {
    await invitation(serviceWith(httpApiEnv(), NO_MAILBOX, i18n));

    expect(lastAccepted()).not.toHaveProperty("reply_to");
  });

  it("does the same over the environment's SMTP server", async () => {
    await invitation(serviceWith(SMTP_ENV, STORED, i18n));

    expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: { name: "Brf Eksemplet", address: "utskick@delad.example" },
      replyTo: "styrelsen@eksemplet.example",
    });
  });
});

describe("the sender and the Reply-To, from the board's own settings", () => {
  it("are exactly what the board stored, and nothing is added", async () => {
    // The board mailbox is configured here too, and still no Reply-To appears:
    // the defaults belong to a sender the host chose, not the board's own.
    await invitation(serviceWith(TEST_ENV, STORED, i18n));

    expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: "styrelsen@eksemplet.example",
      replyTo: undefined,
    });
  });

  it("keep a Reply-To the message names", async () => {
    await invitation(serviceWith(TEST_ENV, STORED, i18n), {
      replyTo: "egen@eksemplet.example",
    });

    expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: "styrelsen@eksemplet.example",
      replyTo: "egen@eksemplet.example",
    });
  });
});

describe("whether mail is configured", () => {
  it("is true whenever the environment chooses a driver", async () => {
    const service = serviceWith(httpApiEnv(), ASSOCIATION, i18n);

    expect(await service.isConfigured()).toBe(true);
  });

  it("follows the stored settings otherwise", async () => {
    expect(await serviceWith(TEST_ENV, ASSOCIATION, i18n).isConfigured()).toBe(
      false,
    );
    expect(await serviceWith(TEST_ENV, STORED, i18n).isConfigured()).toBe(true);
  });
});

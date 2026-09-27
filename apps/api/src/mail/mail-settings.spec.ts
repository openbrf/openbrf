import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { MailSettingsResolver } from "./mail-settings";

/**
 * Which mail the instance uses, and that the environment decides it when it
 * says anything at all (ADR 0024).
 */

const BASE_ENV = {
  NODE_ENV: "test",
  APP_URL: "https://brf.example.se",
  OPENBRF_MAIL_DRIVER: "settings",
} as Env;

const HTTP_API_ENV = {
  ...BASE_ENV,
  OPENBRF_MAIL_DRIVER: "http-api",
  OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
  OPENBRF_MAIL_API_URL: "https://api.mail.example/v1",
  OPENBRF_MAIL_API_KEY: "key-from-the-environment",
  OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "mail.example",
} as Env;

const SMTP_ENV = {
  ...BASE_ENV,
  OPENBRF_MAIL_DRIVER: "smtp",
  OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
  OPENBRF_MAIL_FROM_NAME: "Driftad förening",
  OPENBRF_MAIL_REPLY_TO: "svar@delad.example",
  OPENBRF_SMTP_HOST: "smtp.host.example",
} as Env;

/** What a board stored in the settings before the environment said anything. */
const STORED = {
  smtpHost: "smtp.stored.example",
  smtpPort: null,
  smtpSecure: true,
  smtpUser: "styrelsen",
  smtpPasswordCipher: "brf:stored-ciphertext",
  smtpFromAddress: "styrelsen@eksemplet.example",
};

const NOTHING_STORED = {
  ...STORED,
  smtpHost: null,
  smtpUser: null,
  smtpPasswordCipher: null,
  smtpFromAddress: null,
};

function resolver(env: Env, row: object | null = STORED) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const decrypt = vi.fn().mockResolvedValue("stored-password");
  return {
    resolver: new MailSettingsResolver(
      env,
      { association: { findUnique } } as unknown as PrismaService,
      { decrypt } as unknown as FieldEncryptionService,
    ),
    findUnique,
    decrypt,
  };
}

describe("the environment", () => {
  it("wins over settings the board stored", async () => {
    const { resolver: mail, decrypt } = resolver(HTTP_API_ENV);

    expect(mail.source()).toBe("environment");
    expect(await mail.current()).toEqual({
      source: "environment",
      driver: "http-api",
      api: {
        url: "https://api.mail.example/v1",
        key: "key-from-the-environment",
        messageIdDomain: "mail.example",
      },
      fromAddress: "utskick@delad.example",
      fromName: null,
      replyTo: null,
    });
    // The stored password stays where it is, unread.
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("names the mail API by its host", async () => {
    expect(await resolver(HTTP_API_ENV).resolver.describe()).toEqual({
      source: "environment",
      driver: "http-api",
      host: "api.mail.example",
      fromAddress: "utskick@delad.example",
    });
  });

  it("sets an SMTP server, its sender's name and a Reply-To", async () => {
    expect(await resolver(SMTP_ENV).resolver.current()).toEqual({
      source: "environment",
      driver: "smtp",
      server: {
        host: "smtp.host.example",
        // Not secure unless it says so, and then the submission port.
        port: 587,
        secure: false,
        user: null,
        password: null,
      },
      fromAddress: "utskick@delad.example",
      fromName: "Driftad förening",
      replyTo: "svar@delad.example",
    });
  });

  it("defaults the port to implicit TLS's when the connection is secure", async () => {
    const mail = await resolver({
      ...SMTP_ENV,
      OPENBRF_SMTP_SECURE: true,
      OPENBRF_SMTP_USER: "relay",
      OPENBRF_SMTP_PASSWORD: "relay-password",
    }).resolver.current();

    expect(mail?.driver === "smtp" ? mail.server : null).toEqual({
      host: "smtp.host.example",
      port: 465,
      secure: true,
      user: "relay",
      password: "relay-password",
    });
  });
});

describe("the settings", () => {
  it("are read from the columns when the environment chooses no driver", async () => {
    const { resolver: mail, decrypt } = resolver(BASE_ENV);

    expect(mail.source()).toBe("settings");
    expect(await mail.current()).toEqual({
      source: "settings",
      driver: "smtp",
      server: {
        host: "smtp.stored.example",
        port: 465,
        secure: true,
        user: "styrelsen",
        password: "stored-password",
      },
      fromAddress: "styrelsen@eksemplet.example",
      fromName: null,
      replyTo: null,
    });
    expect(decrypt).toHaveBeenCalledWith(
      "association.smtpPassword",
      "brf:stored-ciphertext",
    );
  });

  it("are none until a host and a sender are both stored", async () => {
    expect(await resolver(BASE_ENV, NOTHING_STORED).resolver.current()).toBe(
      null,
    );
    expect(
      await resolver(BASE_ENV, {
        ...STORED,
        smtpFromAddress: null,
      }).resolver.current(),
    ).toBe(null);
    expect(await resolver(BASE_ENV, null).resolver.describe()).toBe(null);
  });
});

describe("the description", () => {
  it("decrypts nothing", async () => {
    // A screen asking whether mail works has no use for the password, and a
    // description that decrypted it would do so every time one asked.
    const { resolver: mail, decrypt, findUnique } = resolver(BASE_ENV);

    expect(await mail.describe()).toEqual({
      source: "settings",
      driver: "smtp",
      host: "smtp.stored.example",
      fromAddress: "styrelsen@eksemplet.example",
    });
    expect(decrypt).not.toHaveBeenCalled();
    // And it asks for the two columns it names, not the cipher.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { smtpHost: true, smtpFromAddress: true },
    });
  });
});

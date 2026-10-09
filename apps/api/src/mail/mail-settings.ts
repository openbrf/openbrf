import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import { type Env, isLoopbackHost } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { MailApiConfig } from "./http-api-mail.driver";
import type { MailDriverKind } from "./mail-driver";
import { defaultPortFor, type SmtpServer } from "./smtp-mail.driver";

/**
 * The mail this instance actually uses, and where that was decided.
 *
 * One resolver read by everything that needs the answer - sending, the settings
 * screen, and the facts the record of processing activities and the processor
 * register are derived from - so none of them can name a mail server another
 * does not send through (ADR 0024).
 *
 * The environment wins. A driver set there is the host's, who answers for
 * delivery and for the sending domain; the settings the board stored before
 * stay in the database untouched and apply again once the environment stops
 * choosing a driver.
 */

/** Where the effective mail was decided. */
export type MailSource = "environment" | "settings";

/** What a sender is made of before a message gives it a display name. */
interface EffectiveSender {
  source: MailSource;
  fromAddress: string;
  /**
   * The display name the environment sets, or null. Null from the environment
   * means the association's registered name, which the mail service reads at
   * each send; from the settings it means none, as it always has.
   */
  fromName: string | null;
  /** The Reply-To the environment sets for messages that name none. */
  replyTo: string | null;
}

export interface EffectiveSmtpMail extends EffectiveSender {
  driver: "smtp";
  server: SmtpServer;
}

export interface EffectiveHttpApiMail extends EffectiveSender {
  source: "environment";
  driver: "http-api";
  api: MailApiConfig;
}

export type EffectiveMail = EffectiveSmtpMail | EffectiveHttpApiMail;

/**
 * The effective mail as a screen or a record names it: where it was decided,
 * the host it goes through and the sender it goes out as. Nothing secret.
 */
export interface MailDescription {
  source: MailSource;
  driver: MailDriverKind;
  /** The SMTP host, or the host of the mail API's address without its port. */
  host: string;
  fromAddress: string;
}

/** The association's columns the board's own mail is read from. */
export const STORED_MAIL_COLUMNS = {
  smtpHost: true,
  smtpPort: true,
  smtpSecure: true,
  smtpRequireTls: true,
  smtpUser: true,
  smtpPasswordCipher: true,
  smtpFromAddress: true,
} as const;

/** The board's own mail as the association row holds it. */
export type StoredMail = Prisma.AssociationGetPayload<{
  select: typeof STORED_MAIL_COLUMNS;
}>;

@Injectable()
export class MailSettingsResolver implements OnModuleInit {
  private readonly logger = new Logger(MailSettingsResolver.name);
  /**
   * The stored password last decrypted, keyed on its cipher text: a mailing
   * resolves the mail once per recipient, and the password changes only when
   * the board saves a new one. The mail driver built from it holds the same
   * value for as long, so keeping it here holds nothing new.
   */
  private decrypted: { cipher: string; password: string } | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /**
   * Says at start that the host's relay may be signed in to in the clear.
   *
   * OPENBRF_SMTP_REQUIRE_TLS=false is a decision about the network, which the
   * instance cannot check, so it is not left to be found in a packet capture.
   */
  onModuleInit(): void {
    const mail = this.fromEnvironment();
    if (
      mail?.driver === "smtp" &&
      !mail.server.secure &&
      this.env.OPENBRF_SMTP_REQUIRE_TLS === false
    ) {
      this.logger.warn(
        `OPENBRF_SMTP_REQUIRE_TLS is false: when ${mail.server.host}:${mail.server.port} ` +
          "offers no STARTTLS, or something on the path removes the offer, " +
          "the sign-in and every message go to it in " +
          "cleartext. Set this only for a relay on a network you trust.",
      );
    }
  }

  /**
   * Where the mail is decided, without reading anything but the environment.
   *
   * Anything other than a driver named in the environment is the settings, so
   * an environment that names none - the default - leaves the board's own.
   */
  source(): MailSource {
    return this.env.OPENBRF_MAIL_DRIVER === "settings"
      ? "settings"
      : "environment";
  }

  private async decryptPassword(cipher: string): Promise<string> {
    if (this.decrypted?.cipher !== cipher) {
      this.decrypted = {
        cipher,
        password: await this.encryption.decrypt(
          "association.smtpPassword",
          cipher,
        ),
      };
    }
    return this.decrypted.password;
  }

  /**
   * The mail to send through, or null when there is none: the environment
   * chooses no driver and the board has not entered a server and a sender.
   *
   * Decrypts the stored password when the settings decide, so only a send
   * calls it.
   */
  async current(): Promise<EffectiveMail | null> {
    const fromEnvironment = this.fromEnvironment();
    if (fromEnvironment !== null) {
      return fromEnvironment;
    }

    return this.currentFrom(
      await this.prisma.association.findUnique({
        where: { id: 1 },
        select: STORED_MAIL_COLUMNS,
      }),
    );
  }

  /**
   * The same answer from an association row the caller has already read.
   *
   * What a send uses: it reads the row for the association's name and colours
   * anyway, and a mailing sends once per recipient, so reading it a second time
   * here would be one query more for every message.
   */
  async currentFrom(
    association: StoredMail | null,
  ): Promise<EffectiveMail | null> {
    const fromEnvironment = this.fromEnvironment();
    if (fromEnvironment !== null) {
      return fromEnvironment;
    }

    if (
      association === null ||
      association.smtpHost === null ||
      association.smtpFromAddress === null
    ) {
      return null;
    }

    const password =
      association.smtpPasswordCipher === null
        ? null
        : await this.decryptPassword(association.smtpPasswordCipher);

    return {
      source: "settings",
      driver: "smtp",
      server: {
        host: association.smtpHost,
        port: association.smtpPort ?? defaultPortFor(association.smtpSecure),
        secure: association.smtpSecure,
        /*
         * As the settings were saved. Every save requires STARTTLS unless the
         * host is on loopback (SettingsService.updateSmtp); a row saved before
         * that keeps the opportunistic upgrade it always had, because a server
         * that offers no STARTTLS would otherwise stop the mail of an instance
         * that works today. The SMTP card says so until the board saves again.
         */
        requireTls: association.smtpRequireTls,
        user: association.smtpUser,
        password,
      },
      fromAddress: association.smtpFromAddress,
      fromName: null,
      replyTo: null,
    };
  }

  /**
   * The effective mail without its secrets, or null when there is none.
   *
   * Decrypts nothing. A screen asking whether mail works, and a record naming
   * the host mail goes through, have no use for the password, and going through
   * {@link current} would decrypt the stored one every time either asked.
   */
  async describe(): Promise<MailDescription | null> {
    const fromEnvironment = this.fromEnvironment();
    if (fromEnvironment !== null) {
      return {
        source: "environment",
        driver: fromEnvironment.driver,
        host:
          fromEnvironment.driver === "smtp"
            ? fromEnvironment.server.host
            : new URL(fromEnvironment.api.url).hostname,
        fromAddress: fromEnvironment.fromAddress,
      };
    }

    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { smtpHost: true, smtpFromAddress: true },
    });
    if (
      association === null ||
      association.smtpHost === null ||
      association.smtpFromAddress === null
    ) {
      return null;
    }
    return {
      source: "settings",
      driver: "smtp",
      host: association.smtpHost,
      fromAddress: association.smtpFromAddress,
    };
  }

  /**
   * The driver the environment sets, or null when it sets none.
   *
   * The variables were checked at boot (config/env.ts): each driver's required
   * ones are present when it is chosen, which is what the assertions below lean
   * on. A value missing here anyway is a configuration that bypassed that
   * check, and it is refused rather than half used.
   */
  private fromEnvironment(): EffectiveMail | null {
    const env = this.env;
    if (this.source() === "settings") {
      return null;
    }

    const sender = {
      source: "environment" as const,
      fromAddress: required(
        env.OPENBRF_MAIL_FROM_ADDRESS,
        "OPENBRF_MAIL_FROM_ADDRESS",
      ),
      fromName: env.OPENBRF_MAIL_FROM_NAME ?? null,
      replyTo: env.OPENBRF_MAIL_REPLY_TO ?? null,
    };

    if (env.OPENBRF_MAIL_DRIVER === "http-api") {
      return {
        ...sender,
        driver: "http-api",
        api: {
          url: required(env.OPENBRF_MAIL_API_URL, "OPENBRF_MAIL_API_URL"),
          key: required(env.OPENBRF_MAIL_API_KEY, "OPENBRF_MAIL_API_KEY"),
          messageIdDomain: required(
            env.OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN,
            "OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN",
          ),
        },
      };
    }

    const secure = env.OPENBRF_SMTP_SECURE ?? false;
    const host = required(env.OPENBRF_SMTP_HOST, "OPENBRF_SMTP_HOST");
    return {
      ...sender,
      driver: "smtp",
      server: {
        host,
        port: env.OPENBRF_SMTP_PORT ?? defaultPortFor(secure),
        secure,
        /*
         * Encrypted before the sign-in, unless the relay is on this machine or
         * the host says the network to it is trusted. The host's credentials
         * may send for a domain many associations share, so a relay that stops
         * offering STARTTLS is a failure to act on rather than a password sent
         * in the clear.
         */
        requireTls: env.OPENBRF_SMTP_REQUIRE_TLS ?? !isLoopbackHost(host),
        user: env.OPENBRF_SMTP_USER ?? null,
        password: env.OPENBRF_SMTP_PASSWORD ?? null,
      },
    };
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(
      `${name} is required by the mail driver OPENBRF_MAIL_DRIVER names.`,
    );
  }
  return value;
}

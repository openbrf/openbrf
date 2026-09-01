import { Inject, Injectable, Logger } from "@nestjs/common";
import { render } from "react-email";
import { createTransport, type Transporter } from "nodemailer";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { mediaUrl } from "../media/media.service";
import type {
  MailBrand,
  MailTemplate,
  MailTemplateContext,
  RenderedMail,
} from "./mail-template";

/** Accent used when the association has not chosen a primary colour. */
const DEFAULT_PRIMARY_COLOR = "#8A6D28";

/**
 * The port to use when the settings name none.
 *
 * Which one depends on the transport, and getting it wrong is a connection
 * failure rather than a cosmetic default: nodemailer's `secure` flag means
 * IMPLICIT TLS, which servers offer on 465, while 587 is the submission port
 * that starts in cleartext and upgrades through STARTTLS. Defaulting a secure
 * connection to 587 asks for a TLS handshake on a port that answers with a
 * greeting, and the send times out.
 */
const IMPLICIT_TLS_PORT = 465;
const STARTTLS_SUBMISSION_PORT = 587;

function defaultPortFor(secure: boolean): number {
  return secure ? IMPLICIT_TLS_PORT : STARTTLS_SUBMISSION_PORT;
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      "SMTP is not configured for this instance. Invitations and sign-in links " +
        "cannot be sent until it is set up in settings.",
    );
    this.name = "MailNotConfiguredError";
  }
}

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export interface SendMailInput<Props> {
  to: string;
  /** The recipient's own locale, not the acting user's. */
  locale: string | null | undefined;
  template: MailTemplate<Props>;
  props: Props;
}

/**
 * Renders and sends correspondence.
 *
 * Two rules are enforced here rather than left to callers:
 *
 *   Every message is rendered with a translator bound to the *recipient's*
 *   locale, so a Swedish resident is never emailed in the language of the
 *   board member who triggered the action.
 *
 *   Every message carries a plain-text alternative, because some clients show
 *   only that and these emails contain sign-in links.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | undefined;
  /** Fingerprint of the settings the cached transporter was built from. */
  private transporterKey: string | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /**
   * Renders a template without sending, for previews and tests.
   */
  async renderMail<Props>(
    input: Omit<SendMailInput<Props>, "to">,
  ): Promise<RenderedMail> {
    const brand = await this.loadBrand();
    const context = this.buildContext(input.locale, brand);

    const subject = input.template.subject(input.props, context);
    const element = input.template.body(input.props, context);

    const [html, text] = await Promise.all([
      render(element),
      render(element, { plainText: true }),
    ]);

    return { subject, html, text };
  }

  /**
   * Whether this instance can send mail at all.
   *
   * Exposed because skipping SMTP in the setup wizard is allowed, and the
   * screens that depend on delivery - invitations, sign-in links - have to be
   * able to say so plainly rather than failing when someone presses send.
   */
  async isConfigured(): Promise<boolean> {
    // The two columns rather than loadSmtpSettings: a presence check has no use
    // for the password, and going through the loader would decrypt the stored
    // secret every time a screen asks whether mail works at all.
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { smtpHost: true, smtpFromAddress: true },
    });

    return (
      association !== null &&
      association.smtpHost !== null &&
      association.smtpFromAddress !== null
    );
  }

  async send<Props>(input: SendMailInput<Props>): Promise<void> {
    const rendered = await this.renderMail(input);
    const smtp = await this.loadSmtpSettings();

    if (smtp === null) {
      if (this.env.NODE_ENV === "production") {
        throw new MailNotConfiguredError();
      }
      if (this.env.NODE_ENV === "development") {
        // Local development without SMTP: log enough to follow the link,
        // rather than failing a flow that is otherwise working. The body is
        // printed only here, because it carries the sign-in or invitation
        // credential in full.
        this.logger.warn(
          `SMTP not configured. Would send "${rendered.subject}" to ${input.to}:\n${rendered.text}`,
        );
        return;
      }

      // Tests run in CI, whose logs are public on this repository. Record that
      // the message was suppressed without printing the credential it carries.
      this.logger.warn(
        `SMTP not configured. Suppressed "${rendered.subject}"; the message ` +
          "body is not logged outside development.",
      );
      return;
    }

    const transporter = this.transporterFor(smtp);
    await transporter.sendMail({
      from: smtp.from,
      to: input.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  private buildContext(
    locale: string | null | undefined,
    brand: MailBrand,
  ): MailTemplateContext {
    const resolved = this.i18n.resolveLocale(locale);
    const dateFormatter = new Intl.DateTimeFormat(resolved, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Europe/Stockholm",
    });
    /*
     * The association's zone here too, and for the harder of the two reasons.
     * A date is wrong by a day at the edges if the zone is wrong; a time of day
     * is wrong by an hour for half the year, and a laundry hour stated an hour
     * from where it was booked is a resident standing in front of a machine
     * somebody else is using.
     */
    const timeFormatter = new Intl.DateTimeFormat(resolved, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Stockholm",
    });

    return {
      t: this.i18n.translatorFor(resolved),
      locale: resolved,
      brand,
      appUrl: this.env.APP_URL,
      formatDate: (date) => dateFormatter.format(date),
      formatTime: (date) => timeFormatter.format(date),
    };
  }

  private async loadBrand(): Promise<MailBrand> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
    });

    return {
      associationName: association?.name ?? "Open BRF",
      primaryColor: association?.primaryColor ?? DEFAULT_PRIMARY_COLOR,
      logoUrl: this.absoluteLogoUrl(association?.logoFileId ?? null),
    };
  }

  /**
   * The logo's address as a mail client will fetch it.
   *
   * Absolute, because a mail client cannot resolve a relative path, and always
   * on this instance's own origin: the file is served by the API whichever
   * storage driver holds it, so a recipient's mail client contacts the housing
   * cooperative and nobody else.
   *
   * The light variant deliberately, not the dark one. Mail is read on whatever
   * background the client chooses and the platform cannot know which, so the
   * template places the mark on its own light plate.
   */
  private absoluteLogoUrl(logoFileId: string | null): string | undefined {
    if (logoFileId === null) {
      return undefined;
    }
    return new URL(mediaUrl(logoFileId), this.env.APP_URL).toString();
  }

  private async loadSmtpSettings(): Promise<SmtpSettings | null> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
    });

    if (
      association === null ||
      association.smtpHost === null ||
      association.smtpFromAddress === null
    ) {
      return null;
    }

    const password =
      association.smtpPasswordCipher === null
        ? undefined
        : await this.encryption.decrypt(
            "association.smtpPassword",
            association.smtpPasswordCipher,
          );

    return {
      host: association.smtpHost,
      port: association.smtpPort ?? defaultPortFor(association.smtpSecure),
      secure: association.smtpSecure,
      user: association.smtpUser ?? undefined,
      password,
      from: association.smtpFromAddress,
    };
  }

  private transporterFor(smtp: SmtpSettings): Transporter {
    // Settings change from the settings screen, so the cached transporter is
    // keyed on them rather than built once at boot.
    const key = JSON.stringify([
      smtp.host,
      smtp.port,
      smtp.secure,
      smtp.user,
      smtp.password,
    ]);

    if (this.transporter !== undefined && this.transporterKey === key) {
      return this.transporter;
    }

    this.transporter?.close();
    this.transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth:
        smtp.user === undefined
          ? undefined
          : { user: smtp.user, pass: smtp.password ?? "" },
    });
    this.transporterKey = key;
    return this.transporter;
  }
}

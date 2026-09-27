import { Inject, Injectable, Logger } from "@nestjs/common";
import { ASSOCIATION_TIME_ZONE } from "@openbrf/shared";
import { render } from "react-email";

import { boardMailboxConfigured } from "../board-mailbox/board-mailbox-settings";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Association } from "../generated/prisma/client";
import { I18nService } from "../i18n/i18n.service";
import { mediaUrl } from "../media/media.service";
import { HttpApiMailDriver } from "./http-api-mail.driver";
import type { MailDriver, SentMail } from "./mail-driver";
import { type EffectiveMail, MailSettingsResolver } from "./mail-settings";
import type {
  MailBrand,
  MailTemplate,
  MailTemplateContext,
  RenderedMail,
} from "./mail-template";
import { SmtpMailDriver } from "./smtp-mail.driver";

/** Accent used when the association has not chosen a primary colour. */
const DEFAULT_PRIMARY_COLOR = "#8A6D28";

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      "SMTP is not configured for this instance. Invitations and sign-in links " +
        "cannot be sent until it is set up in settings.",
    );
    this.name = "MailNotConfiguredError";
  }
}

export interface SendMailInput<Props> {
  to: string;
  /** The recipient's own locale, not the acting user's. */
  locale: string | null | undefined;
  template: MailTemplate<Props>;
  props: Props;
  /**
   * Where an answer to this message should go, when that is not the address it
   * was sent from.
   *
   * The board's shared mailbox is what this exists for: a reply goes out through
   * whatever identity the instance's mail server accepts, and the conversation
   * has to come back to the address the board published rather than to that
   * relay. Nothing else sets it, and most correspondence should not - an
   * invitation or a sign-in link is not a message to answer.
   */
  replyTo?: string;

  /**
   * This message's own RFC 5322 identifier, and the one it answers.
   *
   * Set together, by a caller that stores the conversation: the identifier has
   * to be known before the message is handed over, because it is what a later
   * reply is matched against on the way back in.
   *
   * Three named fields rather than an arbitrary header bag, and that is a
   * boundary rather than a convenience. A caller that could set any header could
   * set Bcc, or From, or an authentication result, from a value that came from
   * somewhere else - and the one caller here composes its threading from a
   * message written by somebody outside the association.
   */
  messageId?: string | null;
  inReplyTo?: string | null;
}

/**
 * The longest display name a sender carries. The mail API contract's bound; an
 * association's registered name is shorter, and the configured one is checked
 * against it at boot.
 */
const MAX_DISPLAY_NAME = 255;

/**
 * Runs of line breaks and other control characters.
 *
 * The rule against control characters in a pattern is disabled for this one
 * line, the case it makes an exception for: the pattern exists to take them out
 * of a name that becomes part of a header.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

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
 *
 * Where the message goes is the resolver's answer (mail-settings.ts), and how
 * it gets there is a driver's (mail-driver.ts). When whoever runs the instance
 * sets the mail, the sender's address is theirs and need not be on the
 * association's domain, so this service gives it the association's name and
 * directs replies to the association (ADR 0024).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private driver: MailDriver | undefined;
  /** Fingerprint of the settings the cached driver was built from. */
  private driverKey: string | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly mailSettings: MailSettingsResolver,
  ) {}

  /**
   * Renders a template without sending, for previews and tests.
   */
  async renderMail<Props>(
    input: Omit<SendMailInput<Props>, "to">,
  ): Promise<RenderedMail> {
    return this.renderWith(input, this.brandOf(await this.loadAssociation()));
  }

  /**
   * Whether this instance can send mail at all.
   *
   * Exposed because skipping SMTP in the setup wizard is allowed, and the
   * screens that depend on delivery - invitations, sign-in links - have to be
   * able to say so plainly rather than failing when someone presses send.
   * Always true when the environment chooses a driver.
   */
  async isConfigured(): Promise<boolean> {
    // The description rather than the mail itself: a presence check has no use
    // for the password, and resolving the mail would decrypt the stored secret
    // every time a screen asks whether mail works at all.
    return (await this.mailSettings.describe()) !== null;
  }

  /**
   * Renders and sends one message, and reports the identifier it was delivered
   * with.
   *
   * The identifier is the caller's own unless the transport writes its own; a
   * caller that threads replies records what this returns (SentMail).
   */
  async send<Props>(input: SendMailInput<Props>): Promise<SentMail> {
    const association = await this.loadAssociation();
    const rendered = await this.renderWith(input, this.brandOf(association));
    const mail = await this.mailSettings.current();

    if (mail === null) {
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
        return { messageId: null };
      }

      // Tests run in CI, whose logs are public on this repository. Record that
      // the message was suppressed without printing the credential it carries.
      this.logger.warn(
        `SMTP not configured. Suppressed "${rendered.subject}"; the message ` +
          "body is not logged outside development.",
      );
      return { messageId: null };
    }

    const sender = this.senderFor(mail, association);
    return this.driverFor(mail).send({
      from: sender.from,
      to: input.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: input.replyTo ?? sender.replyTo,
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
    });
  }

  /**
   * Who a message is from, and where a reply goes when it names nowhere itself.
   *
   * From the settings, exactly as the board entered it: the stored address with
   * no display name, and no Reply-To of its own. From the environment, the
   * address is the host's and may be on a domain many associations share, so a
   * correspondent needs the association's name to know who wrote, and a reply
   * has to reach the association rather than that shared address: the
   * configured Reply-To, else the board mailbox's published address, else none.
   */
  private senderFor(
    mail: EffectiveMail,
    association: Association | null,
  ): {
    from: { name: string | null; address: string };
    replyTo: string | null;
  } {
    if (mail.source === "settings") {
      return { from: { name: null, address: mail.fromAddress }, replyTo: null };
    }

    const boardMailbox =
      association !== null && boardMailboxConfigured(association)
        ? association.boardMailboxAddress
        : null;

    return {
      from: {
        // Read at each send, so a board that renames the association is named
        // by the next message.
        name: mail.fromName ?? displayNameOf(association?.name ?? null),
        address: mail.fromAddress,
      },
      replyTo: mail.replyTo ?? boardMailbox,
    };
  }

  /**
   * The driver for the effective mail, reused while it is unchanged.
   *
   * The settings change from the settings screen, so the cached driver is keyed
   * on them rather than built once at boot; a driver built for other settings
   * is closed as it is replaced.
   */
  private driverFor(mail: EffectiveMail): MailDriver {
    const key = JSON.stringify(
      mail.driver === "smtp"
        ? [
            mail.driver,
            mail.server.host,
            mail.server.port,
            mail.server.secure,
            mail.server.user,
            mail.server.password,
          ]
        : [mail.driver, mail.api.url, mail.api.key, mail.api.messageIdDomain],
    );

    if (this.driver !== undefined && this.driverKey === key) {
      return this.driver;
    }

    this.driver?.close();
    this.driver =
      mail.driver === "smtp"
        ? new SmtpMailDriver(mail.server)
        : new HttpApiMailDriver(mail.api);
    this.driverKey = key;
    return this.driver;
  }

  private async renderWith<Props>(
    input: Omit<SendMailInput<Props>, "to">,
    brand: MailBrand,
  ): Promise<RenderedMail> {
    const context = this.buildContext(input.locale, brand);

    const subject = input.template.subject(input.props, context);
    const element = input.template.body(input.props, context);

    const [html, text] = await Promise.all([
      render(element),
      render(element, { plainText: true }),
    ]);

    return { subject, html, text };
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
      timeZone: ASSOCIATION_TIME_ZONE,
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
      timeZone: ASSOCIATION_TIME_ZONE,
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

  private async loadAssociation(): Promise<Association | null> {
    return this.prisma.association.findUnique({ where: { id: 1 } });
  }

  private brandOf(association: Association | null): MailBrand {
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
}

/**
 * The association's registered name as a display name, or null for none.
 *
 * One line, because it becomes part of a header: the name is typed into a form,
 * and a line break or another control character in it is replaced rather than
 * written where it could start a header of its own.
 */
function displayNameOf(name: string | null): string | null {
  if (name === null) {
    return null;
  }
  const oneLine = name
    .replace(CONTROL_CHARACTERS, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME);
  return oneLine === "" ? null : oneLine;
}

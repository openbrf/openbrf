import type { ReactElement } from "react";
import type { TFunction } from "i18next";

import type { SeedKey } from "../data-protection/processing-activity-seed";

/**
 * Branding available to correspondence.
 *
 * Email and PDF extracts are themed with the logo and the primary colour only;
 * full theming of print and mail is deliberately deferred (see the theme
 * contract). Everything else in a template uses literal values, because email
 * clients do not support CSS custom properties and the token contract
 * therefore cannot reach them.
 */
export interface MailBrand {
  associationName: string;
  /** Association primary colour, or the default theme's accent. */
  primaryColor: string;
  /** Absolute URL; relative paths do not resolve in a mail client. */
  logoUrl?: string;
}

export interface MailTemplateContext {
  t: TFunction;
  /** Resolved recipient locale, used for the document's lang attribute. */
  locale: string;
  brand: MailBrand;
  /** Absolute base URL of this instance, for links. */
  appUrl: string;
  /** Formats the day an instant falls on, in the recipient's locale. */
  formatDate: (date: Date) => string;
  /**
   * Formats a `@db.Date` column in the recipient's locale.
   *
   * A date column is read back as midnight UTC, and the day it names is that
   * day whatever the association's clock says. Formatting it as an instant
   * on the association's clock is right only while that clock is ahead of UTC,
   * so a date column - a move-in day, a due date - is formatted with this.
   */
  formatDateColumn: (date: Date) => string;
  /**
   * Formats a time of day in the recipient's locale, on the association's
   * clock.
   *
   * Separate from {@link MailTemplateContext.formatDate} rather than one
   * formatter carrying both, because the two are wanted apart: a laundry hour
   * is one date and two times, and repeating the date beside each of them is
   * how a reader loses which day it is.
   */
  formatTime: (date: Date) => string;
}

/**
 * One email. Templates are plain objects rather than classes so a plugin can
 * contribute one without importing anything from Nest.
 */
export interface MailTemplate<Props> {
  /** Stable identifier, used in logs and tests. */
  id: string;
  /**
   * The processing in the record of processing activities this mail is sent
   * under, which therefore names the mail server among its recipients (GDPR
   * art. 30(1)(d)).
   *
   * Declared on the template because every caller of MailService hands it
   * one, so a mailer cannot be written without saying which row it belongs
   * to, and the seed reads the rows that name the mail server from here
   * rather than from a list kept beside them (`processing-activity-seed.ts`).
   * Null only for a mail sent on no processing the association records:
   * `mail-processing.spec.ts` names each one and why.
   */
  processing: SeedKey | null;
  subject: (props: Props, context: MailTemplateContext) => string;
  body: (props: Props, context: MailTemplateContext) => ReactElement;
}

export interface RenderedMail {
  subject: string;
  html: string;
  /** Plain-text alternative. Never omitted: some clients show only this. */
  text: string;
}

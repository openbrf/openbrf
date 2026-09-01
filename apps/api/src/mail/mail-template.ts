import type { ReactElement } from "react";
import type { TFunction } from "i18next";

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
  /** Formats a date in the recipient's locale. */
  formatDate: (date: Date) => string;
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
  subject: (props: Props, context: MailTemplateContext) => string;
  body: (props: Props, context: MailTemplateContext) => ReactElement;
}

export interface RenderedMail {
  subject: string;
  html: string;
  /** Plain-text alternative. Never omitted: some clients show only this. */
  text: string;
}

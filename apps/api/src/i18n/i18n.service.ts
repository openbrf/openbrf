import { Injectable, type OnModuleInit } from "@nestjs/common";
import en from "@openbrf/i18n/locales/en.json";
import sv from "@openbrf/i18n/locales/sv.json";
import { createInstance, type i18n, type TFunction } from "i18next";

/**
 * Supported UI and correspondence locales. Swedish is the default because the
 * product is Swedish-first; English is the fallback and the canonical key
 * source (decision 34).
 */
export const SUPPORTED_LOCALES = ["sv", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "sv";
export const FALLBACK_LOCALE: Locale = "en";

const DEFAULT_NAMESPACE = "translation";

/**
 * Server-side translation.
 *
 * Uses i18next directly rather than nestjs-i18n, because plugins merge their
 * own locale files at runtime through addResourceBundle and only i18next
 * supports that (decision 34).
 *
 * Correspondence is always rendered with getFixedT for the recipient's own
 * locale: a request's language says what the *sender* is reading, which is the
 * wrong language for an email to a resident.
 */
@Injectable()
export class I18nService implements OnModuleInit {
  private readonly instance: i18n = createInstance();

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  /** Exposed so tests and scripts can use the service without a Nest context. */
  async init(): Promise<void> {
    if (this.instance.isInitialized) {
      return;
    }
    await this.instance.init({
      resources: {
        en: { [DEFAULT_NAMESPACE]: en },
        sv: { [DEFAULT_NAMESPACE]: sv },
      },
      lng: DEFAULT_LOCALE,
      fallbackLng: FALLBACK_LOCALE,
      defaultNS: DEFAULT_NAMESPACE,
      interpolation: {
        // Nothing here renders into HTML without its own escaping, and
        // escaping twice mangles Swedish text in plain-text mail.
        escapeValue: false,
      },
    });
  }

  /**
   * Returns a translator bound to one locale, for rendering a message to a
   * specific recipient.
   */
  translatorFor(locale: string | null | undefined): TFunction {
    return this.instance.getFixedT(this.resolveLocale(locale));
  }

  /**
   * Narrows arbitrary stored or requested language values onto a supported
   * locale. A person's preferredLocale comes from the database and an Accept
   * headers comes from the network, so neither can be trusted to be supported.
   */
  resolveLocale(locale: string | null | undefined): Locale {
    if (locale === null || locale === undefined) {
      return DEFAULT_LOCALE;
    }
    // Accept a full tag such as "sv-SE" by taking its primary subtag.
    const primary = locale.trim().toLowerCase().split("-")[0];
    return (
      SUPPORTED_LOCALES.find((supported) => supported === primary) ??
      DEFAULT_LOCALE
    );
  }

  /**
   * Merges a plugin's locale files at runtime under its own namespace, so a
   * plugin's strings cannot collide with the core's (decision 35).
   */
  addPluginResources(
    pluginId: string,
    resources: Partial<Record<Locale, Record<string, unknown>>>,
  ): void {
    const namespace = `plugin-${pluginId}`;
    for (const locale of SUPPORTED_LOCALES) {
      const bundle = resources[locale];
      if (bundle !== undefined) {
        this.instance.addResourceBundle(locale, namespace, bundle, true, true);
      }
    }
  }
}

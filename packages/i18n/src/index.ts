import en from "./locales/en.json";
import sv from "./locales/sv.json";

/**
 * English is the canonical type source per CONTRIBUTING.md: every locale
 * must provide exactly the keys that exist in en.json.
 */
export type TranslationSchema = typeof en;

export const defaultNS = "translation";

export const resources = {
  en: { translation: en },
  sv: { translation: sv satisfies TranslationSchema },
} as const;

export type Resources = {
  translation: TranslationSchema;
};

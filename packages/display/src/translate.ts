/**
 * The renderer's words in a screen's locale, with i18next's interpolation and
 * plural keys, so the translations read the same here as in packages/i18n.
 */
import type { ScreenLocale } from "./contract.ts";
import { WORDS, type WordKey } from "./words.ts";

type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

type PluralBase<Key> = Key extends `${infer Base}_other` ? Base : never;

/** A word to look up: a key, or the base of a plural key such as `placesLeft`. */
export type Phrase =
  Exclude<WordKey, `${string}_${PluralCategory}`> | PluralBase<WordKey>;

const pluralRules = new Map<ScreenLocale, Intl.PluralRules>();

function pluralCategory(locale: ScreenLocale, count: number): string {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

function lookup(locale: ScreenLocale, key: string): string | undefined {
  const words: Readonly<Record<string, string>> = WORDS[locale];
  return Object.prototype.hasOwnProperty.call(words, key)
    ? words[key]
    : undefined;
}

/**
 * The word for `phrase` in `locale`, its `{{name}}` placeholders filled from
 * `values`. A numeric `count` picks the plural form, `<phrase>_one` or
 * `<phrase>_other`, by the locale's plural rules.
 */
export function translate(
  locale: ScreenLocale,
  phrase: Phrase,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const count = values["count"];
  const text =
    (typeof count === "number"
      ? (lookup(locale, `${phrase}_${pluralCategory(locale, count)}`) ??
        lookup(locale, `${phrase}_other`))
      : undefined) ??
    lookup(locale, phrase) ??
    phrase;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

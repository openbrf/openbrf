import {
  DEFAULT_LOCALE,
  type Locale,
  SUPPORTED_LOCALES,
} from "../i18n/i18n.service";

/**
 * Which language to render the public website in.
 *
 * The visitor has no account and therefore no stored preference, so the only
 * thing there is to go on is the Accept-Language header their browser sends. It
 * is read here rather than anywhere else in the codebase because it is the one
 * place a language is chosen for someone who has not told us who they are: an
 * email is rendered in the recipient's own stored locale, and the interface in
 * the signed-in person's.
 *
 * The order is: the first language the visitor asked for that this instance
 * actually has, then the association's own default, then Swedish. Falling back
 * to the association's default rather than straight to Swedish matters for an
 * English-speaking cooperative, whose website should not answer a visitor with
 * no preference in a language the association does not write in.
 *
 * Quality values are parsed only far enough to be discarded. Honouring the
 * weights would mean sorting, and with two supported languages the sort can
 * only ever agree with the header's own order.
 */
export function visitorLocale(
  acceptLanguage: string | undefined | null,
  associationDefault: string | undefined | null,
): Locale {
  const asked = preferredLocale(acceptLanguage);
  if (asked !== null) {
    return asked;
  }

  const fallback = supportedPrimarySubtag(associationDefault ?? "");
  return fallback ?? DEFAULT_LOCALE;
}

/** The first language in the header this instance can render, or null. */
function preferredLocale(header: string | undefined | null): Locale | null {
  if (header === undefined || header === null) {
    return null;
  }

  for (const entry of header.split(",")) {
    // "sv-SE;q=0.9" - the tag is everything before the first parameter.
    const [tag = "", ...parameters] = entry.split(";");

    /*
     * q=0 is a refusal, not a weak preference: "sv;q=0,en" asks for anything
     * but Swedish. Header order decides the rest, so the quality values are
     * otherwise ignored - a visitor who ranks two languages this instance has
     * gets the one they wrote first, which is the same answer ordering alone
     * would give.
     */
    if (
      parameters.some((parameter) =>
        /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter),
      )
    ) {
      continue;
    }

    const locale = supportedPrimarySubtag(tag);
    if (locale !== null) {
      return locale;
    }
    // "*" and any language this instance does not have fall through to the
    // next entry rather than ending the search.
  }
  return null;
}

/** A language tag narrowed to a supported locale, or null if it is not one. */
function supportedPrimarySubtag(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split("-")[0] ?? "";
  return SUPPORTED_LOCALES.find((supported) => supported === primary) ?? null;
}

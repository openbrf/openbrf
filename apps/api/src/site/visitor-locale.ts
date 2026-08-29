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
 * Quality values decide, and the header's order breaks a tie. Both halves are
 * needed: a browser normally writes its languages in descending weight, so
 * order alone usually agrees - but nothing requires it to, and a header that
 * asks for Swedish at 0.2 and English at 0.9 is asking for English however it
 * was written down. A zero weight is a refusal rather than a weak preference,
 * and survives into the fallback below.
 */
/** "q=0", in the shapes RFC 9110 allows for it. */
const ZERO_QUALITY = /^\s*q\s*=\s*0(?:\.0*)?\s*$/i;

export function visitorLocale(
  acceptLanguage: string | undefined | null,
  associationDefault: string | undefined | null,
): Locale {
  const asked = preferredLocale(acceptLanguage);
  if (asked !== null) {
    return asked;
  }

  /*
   * A refusal outlives the header it was written in. "sv;q=0" on an instance
   * whose own default is Swedish would otherwise fall straight back onto the
   * language the visitor just said they did not want, which is the one answer
   * the header ruled out.
   */
  const refused = refusedLocales(acceptLanguage);
  const fallback = supportedPrimarySubtag(associationDefault ?? "");
  for (const candidate of [fallback, DEFAULT_LOCALE]) {
    if (candidate !== null && !refused.has(candidate)) {
      return candidate;
    }
  }
  const spare = SUPPORTED_LOCALES.find((locale) => !refused.has(locale));

  // Every language this instance has was refused. The page still has to be
  // rendered in one, so the association's own is the least surprising.
  return spare ?? fallback ?? DEFAULT_LOCALE;
}

/** Locales the header explicitly refused with a zero quality value. */
function refusedLocales(header: string | undefined | null): Set<Locale> {
  const refused = new Set<Locale>();
  if (header === undefined || header === null) {
    return refused;
  }

  for (const entry of header.split(",")) {
    const [tag = "", ...parameters] = entry.split(";");
    if (!parameters.some((parameter) => ZERO_QUALITY.test(parameter))) {
      continue;
    }
    const locale = supportedPrimarySubtag(tag);
    if (locale !== null) {
      refused.add(locale);
    }
  }
  return refused;
}

/** The language this instance can render that the visitor asked for most. */
function preferredLocale(header: string | undefined | null): Locale | null {
  if (header === undefined || header === null) {
    return null;
  }

  let best: { locale: Locale; quality: number } | null = null;

  for (const entry of header.split(",")) {
    // "sv-SE;q=0.9" - the tag is everything before the first parameter.
    const [tag = "", ...parameters] = entry.split(";");

    const locale = supportedPrimarySubtag(tag);
    if (locale === null) {
      // "*" and any language this instance does not have fall through to the
      // next entry rather than ending the search.
      continue;
    }

    // q=0 is a refusal rather than a weak preference: "sv;q=0,en" asks for
    // anything but Swedish, and no ordering expresses that.
    const quality = qualityOf(parameters);
    if (quality === 0) {
      continue;
    }

    /*
     * Strictly greater, so an equal weight leaves the earlier entry standing:
     * where the visitor expressed no preference between two languages, the
     * order they wrote them in is the only thing left to go on.
     */
    if (best === null || quality > best.quality) {
      best = { locale, quality };
    }
  }

  return best?.locale ?? null;
}

/**
 * The weight an Accept-Language entry carries, defaulting to 1.
 *
 * A malformed weight is read as the default rather than as a refusal: the
 * header comes from whatever software the visitor happens to be using, and
 * answering nothing at all because one parameter is unparseable would be a
 * worse failure than ignoring it.
 */
function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const match = /^\s*q\s*=\s*(\d(?:\.\d+)?)\s*$/i.exec(parameter);
    if (match !== undefined && match !== null) {
      const quality = Number(match[1]);
      return Number.isFinite(quality) ? Math.min(quality, 1) : 1;
    }
  }
  return 1;
}

/** A language tag narrowed to a supported locale, or null if it is not one. */
function supportedPrimarySubtag(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split("-")[0] ?? "";
  return SUPPORTED_LOCALES.find((supported) => supported === primary) ?? null;
}

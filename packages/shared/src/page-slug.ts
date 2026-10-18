/**
 * A page's address, made from its title.
 *
 * Shared because both sides need the same answer: the board's screen shows the
 * address a title will give while it is being typed, and the API is what
 * decides it. Two copies of the rule would show the board one address and
 * store another.
 *
 * What this returns is the address the title asks for. Whether it is free is
 * the API's question - a reserved name or one another page holds is given a
 * numbered suffix there, by {@link numberedSlug}.
 */

/** As long an address as a page may have; the API's shape rule says the same. */
export const PAGE_SLUG_MAX_LENGTH = 80;

/**
 * The address a title with no letters or digits in it is given.
 *
 * A constant rather than a translated word, like the privacy notice's address:
 * an address is the same on every instance whatever language its board writes
 * in, and a title of nothing but punctuation is rare enough that one word for
 * it is enough.
 */
export const PAGE_SLUG_FALLBACK = "sida";

/**
 * Letters that do not decompose into a Latin letter and a mark.
 *
 * Swedish å, ä and ö decompose on their own - into a, a and o and the mark
 * above them, which is dropped - so they need no entry here. These are the
 * neighbours a Nordic board is likely to type and that would otherwise be
 * dropped as not being letters at all.
 */
const SPELLED_OUT: Readonly<Record<string, string>> = {
  æ: "ae",
  ø: "o",
  ß: "ss",
  đ: "d",
  ł: "l",
  þ: "th",
  ð: "d",
};

/**
 * The address a title asks for.
 *
 * Lowercase Latin letters, digits and single hyphens, with å/ä/ö read as
 * a/a/o, every other run of characters as one hyphen, and nothing at either
 * end. Never longer than an address may be, and never empty.
 */
export function slugFromTitle(title: string): string {
  const spelled = title
    .toLowerCase()
    .replace(/[æøßđłþð]/g, (character) => SPELLED_OUT[character] ?? character);
  const slug = spelled
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, PAGE_SLUG_MAX_LENGTH).replace(/-+$/, "");
  return cut === "" ? PAGE_SLUG_FALLBACK : cut;
}

/**
 * The `n`th address to try for a slug: the slug itself, then `-2`, `-3` and on.
 *
 * Cut before the suffix rather than after, so the number is never the part
 * that is lost to the length limit - two pages titled the same would
 * otherwise be offered one address.
 */
export function numberedSlug(slug: string, n: number): string {
  if (n <= 1) {
    return slug;
  }
  const suffix = `-${String(n)}`;
  const base = slug
    .slice(0, PAGE_SLUG_MAX_LENGTH - suffix.length)
    .replace(/-+$/, "");
  return `${base}${suffix}`;
}

/**
 * The catalog's own text, in the viewer's language.
 *
 * A catalog entry's name and description are written by whoever curates the
 * catalog, in both languages the interface is offered in, and arrive as data
 * rather than as translation keys. Swedish for a Swedish locale and English
 * for anything else, which is the fallback the interface's own strings use.
 */
export function catalogText(
  text: { sv: string; en: string },
  locale: string,
): string {
  return locale.startsWith("sv") ? text.sv : text.en;
}

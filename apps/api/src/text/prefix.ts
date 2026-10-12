/**
 * The first `length` characters of the text, or one fewer where the cut would
 * split a character written as a surrogate pair. Half a pair is not a
 * character: it renders as a replacement glyph, and it serialises as an escape
 * (`\ud83d`) that Postgres refuses in a JSON column.
 */
export function prefix(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

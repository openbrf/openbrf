import { normalizeFreeText, normalizeSingleLineText } from "@openbrf/shared";

/**
 * The input with the named text fields folded, once, before they are scanned
 * for a personal identity number and stored.
 *
 * What the board typed is what is stored, so what the scan checked has to be
 * what is stored. A scan that folds and a store that does not leave the two
 * apart: a number split by a zero-width character is refused today, and the
 * same text a spelling later would reach the row as typed. One rule for the
 * records the data protection screens keep: fold on write ({@link
 * normalizeFreeText}, line breaks kept; {@link normalizeSingleLineText} for a
 * name or a title).
 */
export function foldedText<T extends object>(
  input: T,
  fields: { oneLine?: readonly string[]; freeText?: readonly string[] },
): T {
  const folded: Record<string, unknown> = { ...(input as object) };
  for (const [field, value] of Object.entries(folded)) {
    if (typeof value !== "string") {
      continue;
    }
    if (fields.oneLine?.includes(field) === true) {
      folded[field] = normalizeSingleLineText(value);
    } else if (fields.freeText?.includes(field) === true) {
      folded[field] = normalizeFreeText(value);
    }
  }
  return folded as T;
}

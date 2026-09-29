/**
 * A text field the caller left empty, read as no answer.
 *
 * A form sends an emptied field as "" or as whitespace, not as a missing key.
 * Stored as it came, that empty string would count as an answer: it would win
 * over a default, or be recorded where the record means "none given". One
 * module, because the settings screens and the plugin consent step both read
 * answers this way.
 */
export function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

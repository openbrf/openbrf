/**
 * Text that becomes part of a mail header.
 *
 * One module, because the same rule is applied in three places: the display
 * name the environment sets is refused at boot if it breaks it (config/env.ts),
 * the mail service holds every name and subject it sends to it, and the board
 * mailbox holds what an outside sender wrote to it on the way in.
 */

/**
 * The longest display name a sender carries. The mail API contract's bound; an
 * association's registered name is shorter.
 */
export const MAX_DISPLAY_NAME = 255;

/**
 * Runs of line breaks and other control characters.
 *
 * The rule against control characters in a pattern is disabled for this one
 * line, the case it makes an exception for: the pattern exists to find them in
 * a value that becomes part of a header, and the alternative to naming them is
 * not naming them.
 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/** Whether the value holds a line break or any other control character. */
export function hasControlCharacter(value: string): boolean {
  // search() ignores the pattern's lastIndex, which test() on a global
  // pattern would carry from one call to the next.
  return value.search(CONTROL_CHARACTERS) !== -1;
}

/**
 * The value on one line: each run of control characters replaced by a space,
 * and the ends trimmed.
 *
 * A space rather than nothing, so two words a line break separated stay two.
 */
export function oneLine(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").trim();
}

/**
 * The characters that reorder the text around them without being seen.
 *
 * A right-to-left override shows `invoice\u202Efdp.exe` as "invoiceexe.pdf",
 * and the same trick makes a sender's address read as a domain it is not. The
 * embeddings, overrides and isolates, and the three invisible marks that set a
 * direction.
 */
export const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/**
 * Characters a reader cannot see: the C1 controls, the soft hyphen, the
 * bidirectional controls above, the zero-width space and joiners, the word
 * joiner and the invisible operators beside it, and the byte order mark.
 *
 * Kept apart from {@link CONTROL_CHARACTERS} because none of these breaks a
 * header line - none encodes to a CR or an LF - so what they threaten is what a
 * person reads rather than what a mail server parses. A name or a subject loses
 * them; an address holding one is not an address anybody typed.
 */
export const INVISIBLE_CHARACTERS =
  /[\u0080-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g;

/** Whether the value holds a character a reader cannot see. */
export function hasInvisibleCharacter(value: string): boolean {
  return value.search(INVISIBLE_CHARACTERS) !== -1;
}

/** The value without the characters a reader cannot see. */
export function withoutInvisibleCharacters(value: string): string {
  return value.replace(INVISIBLE_CHARACTERS, "");
}

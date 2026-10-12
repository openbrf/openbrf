/**
 * A decimal a person typed, in the form the API reads.
 *
 * The fields a figure is typed into use `inputMode="decimal"`, which gives a
 * Swedish keyboard a comma key, and a figure copied from a document the
 * formatter in `money.ts` produced is grouped with a space (a no-break space in
 * Swedish). The API accepts neither: it reads digits and one `.`. So a comma is
 * read as the decimal separator, and spaces are taken out of the whole part when
 * they group it - a group of one to three digits and then groups of exactly
 * three.
 *
 * Spaces anywhere else are not a grouping and are left in place, so the server
 * refuses the figure. Taking every space out would turn "12 34" into 1234 and
 * send a different, valid amount where the board typed a mistake; that matters
 * for a lien amount and for the share capital the apartment register states.
 *
 * Nothing else is corrected. What is left is sent as it stands and the server
 * refuses a malformed figure, rather than this guessing at one: an English
 * "1,500.00" becomes "1.500.00" and is refused, not read as fifteen hundred or
 * as one and a half.
 */
export function decimalFromInput(value: string): string {
  const typed = value.trim();
  const separator = typed.search(/[,.]/u);
  const whole = separator === -1 ? typed : typed.slice(0, separator);
  const rest = separator === -1 ? "" : typed.slice(separator);
  // `\s` takes in the no-break and narrow no-break spaces the formatter prints.
  const digits = /^\d{1,3}(?:\s\d{3})+$/u.test(whole)
    ? whole.replace(/\s/gu, "")
    : whole;
  return `${digits}${rest}`.replaceAll(",", ".");
}

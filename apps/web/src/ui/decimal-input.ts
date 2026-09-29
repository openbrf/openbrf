/**
 * A decimal a person typed, in the form the API reads.
 *
 * The fields a figure is typed into use `inputMode="decimal"`, which gives a
 * Swedish keyboard a comma key, and a figure copied from a document the
 * formatter in `money.ts` produced is grouped with a space (a no-break space in
 * Swedish). The API accepts neither: it reads digits and one `.`. So every
 * whitespace character is taken out and a comma is read as the decimal
 * separator.
 *
 * Nothing else is corrected. What is left is sent as it stands and the server
 * refuses a malformed figure, rather than this guessing at one: an English
 * "1,500.00" becomes "1.500.00" and is refused, not read as fifteen hundred or
 * as one and a half.
 */
export function decimalFromInput(value: string): string {
  return value.replace(/\s/gu, "").replaceAll(",", ".");
}

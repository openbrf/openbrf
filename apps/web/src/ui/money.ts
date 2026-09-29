/**
 * Rendering a sum of money for a reader.
 *
 * The first formatter in this application, and it exists because a fee notice
 * is a document a member reads rather than a register row a board reads. The
 * debiting list prints the server's own string in a mono cell, which is right
 * there: a bookkeeper mapping a column wants exactly what the column holds.
 * "34505000.00" on a notice is not a figure anybody can check against their
 * bank statement.
 *
 * ## It renders a decimal string and never a number
 *
 * The whole point. A `DECIMAL(14, 2)` that has travelled through a double has
 * already lost the argument this product makes everywhere else - the amounts
 * are summed in ore with `BigInt` on the server, refused rather than rounded,
 * and passed on the wire as strings for that reason. So the digits are grouped
 * as digits: the whole part goes through `Intl.NumberFormat` as a `BigInt`,
 * which is exact at any size, and the two decimals are the ones the string
 * already carried.
 *
 * ## The separators come from the reader's locale
 *
 * Swedish groups with a space and separates decimals with a comma; English does
 * the opposite. Both are read off `Intl.NumberFormat` rather than written down
 * here, so a locale added later needs no change. The sample the separators are
 * discovered from is a number and not the amount - it is the only place a float
 * appears in this file, and nothing the reader sees is derived from it.
 *
 * ## The unit is not here
 *
 * "kr" is a word and words live in the locale files. This returns the figure and
 * the caller puts it into a key that carries the unit, which is what lets the
 * English document say the same thing in its own order.
 */

/**
 * A sum of kronor and ore as a column of this product holds it, or as the
 * browser works one out: the fee screen's unallocated remainder goes below
 * zero when the shares add up to more than one.
 */
const DECIMAL = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Groups and separates a decimal amount for one locale.
 *
 * @param amount The stored amount, e.g. "3450.50". Anything that is not a sum
 *   of kronor and ore is returned unchanged: this is a display helper, the
 *   server is where a malformed amount is refused, and a figure printed raw is
 *   more use to whoever has to report it than a blank or a thrown error on a
 *   screen.
 * @param locale The reader's locale, from `i18n.language`.
 */
export function formatAmount(amount: string, locale: string): string {
  const match = DECIMAL.exec(amount);
  const whole = match?.[2];
  if (whole === undefined) {
    return amount;
  }
  const fraction = (match?.[3] ?? "").padEnd(2, "0");
  // The sign is put on separately rather than formatted with the whole part,
  // which for "-0.50" is a zero and has none.
  const sign = match?.[1] === undefined ? "" : minusSignFor(locale);

  const grouped = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(BigInt(whole));

  return `${sign}${grouped}${decimalSeparatorFor(locale)}${fraction}`;
}

/**
 * The character this locale puts between the whole part and the decimals.
 *
 * Read off a sample rather than written down, so a locale added later is
 * already right. The sample is a literal with one decimal place, which every
 * locale renders with its own separator and which no amount is derived from.
 */
function decimalSeparatorFor(locale: string): string {
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
  }).formatToParts(1.1);
  return parts.find((part) => part.type === "decimal")?.value ?? ".";
}

/** The character this locale puts before a negative number, read off a sample. */
function minusSignFor(locale: string): string {
  return (
    new Intl.NumberFormat(locale)
      .formatToParts(-1)
      .find((part) => part.type === "minusSign")?.value ?? "-"
  );
}

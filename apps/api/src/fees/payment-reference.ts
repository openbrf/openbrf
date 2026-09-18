/**
 * The reference a fee notice is paid under (betalningsreferens).
 *
 * A member rings the board and reads a number off the notice in front of them,
 * and the board has to be able to find the row it belongs to. That is the whole
 * job: the reference identifies one notice, it is stored on the row rather than
 * recomputed, and `FeeNotice.paymentReference` is unique so two notices can
 * never answer to one number.
 *
 * ## The rule
 *
 * Nine digits: the two-digit year and two-digit month the billed period opens
 * in, then the notice's four-digit position in the run it belongs to, then a
 * check digit.
 *
 *     2 6 0 1   0 0 0 7   4
 *     YYMM      NNNN      check
 *
 * The period first because it is the half a person recognises - "that is the
 * January bill" - and because it is what makes the number unique across runs
 * without any state: a period may be issued once and two runs may not overlap,
 * so no two runs open in the same month. The position is assigned by the run
 * over the apartments it bills in a stable order, which makes it unique inside
 * the run. Four digits bounds a run at 9,999 notices; a run larger than that is
 * refused rather than wrapped, because a wrapped position would produce a
 * reference the database has already given to another notice.
 *
 * Deliberately not built from the apartment's number, which is the first thing
 * anyone tries. An apartment number is unique within an address and not within
 * the association - `Apartment` is unique on the address and the number
 * together - so two houses may each have a flat numbered 1101, and a reference
 * built on it would put two households' money under one number. The apartment
 * the reference belongs to is on the notice beside it.
 *
 * ## The check digit
 *
 * Modulus 10, which is what a Swedish OCR reference uses: every second digit
 * from the right of the payload is doubled, the digits of each product are
 * added rather than the product itself, and the check digit is what brings the
 * total to a multiple of ten. It catches every single mistyped digit and every
 * transposition of two adjacent digits except a 0 swapped with a 9, which is
 * the known gap in the method rather than a fault in this use of it. It is not
 * a signature and nothing here treats it as one: the reference is looked up on
 * the notice, and the check digit only saves the board a wrong lookup.
 *
 * ## What this does not promise
 *
 * That the association's bank accepts this shape. An OCR format is an agreement
 * between the association and its own bank: the length, whether a length digit
 * is carried, and whether a reference is checked at all are the bank's terms and
 * not this platform's. Open BRF publishes the rule it computes by - here and in
 * `docs/fee-notice-contract.md` - and the association checks it against its own
 * agreement before it sends four hundred notices.
 *
 * Integer arithmetic throughout, and no floating point anywhere: a check digit
 * derived through a number that has been near a decimal point is a check digit
 * that is sometimes wrong.
 */

/** How many digits the position within a run takes, and so how large a run may be. */
const POSITION_DIGITS = 4;

/** The largest position the format can carry. */
export const MAX_NOTICES_PER_RUN = 10 ** POSITION_DIGITS - 1;

/**
 * The reference for one notice.
 *
 * @param periodFrom The first day of the billed period, as "YYYY-MM-DD". The
 *   year and month of it are what the reference carries.
 * @param position The notice's place in its run, counting from 1.
 * @throws RangeError if the period is not a calendar date, or the position is
 *   not a whole number the format can carry. Refused rather than adjusted: a
 *   position quietly wrapped to four digits collides with one already issued,
 *   and the collision would surface as a failed run with no reason attached.
 */
export function paymentReferenceFor(
  periodFrom: string,
  position: number,
): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodFrom);
  const year = match?.[1];
  const month = match?.[2];
  if (year === undefined || month === undefined) {
    throw new RangeError(
      `A payment reference needs the period as YYYY-MM-DD, got ${periodFrom}.`,
    );
  }

  if (
    !Number.isInteger(position) ||
    position < 1 ||
    position > MAX_NOTICES_PER_RUN
  ) {
    throw new RangeError(
      `A notice's position in its run is 1 to ${String(
        MAX_NOTICES_PER_RUN,
      )}, got ${String(position)}.`,
    );
  }

  const payload = `${year.slice(2)}${month}${String(position).padStart(
    POSITION_DIGITS,
    "0",
  )}`;
  return `${payload}${checkDigitOf(payload)}`;
}

/**
 * Whether a reference's own check digit agrees with the rest of it.
 *
 * Exported for the contract document's sake as much as the code's: whoever
 * reads the format wants to be able to check one reference by hand, and the
 * test that does it here is the worked example.
 */
export function paymentReferenceIsWellFormed(reference: string): boolean {
  if (!/^\d{2,}$/.test(reference)) {
    return false;
  }
  const payload = reference.slice(0, -1);
  return reference.endsWith(checkDigitOf(payload));
}

/**
 * The modulus 10 check digit over a string of digits.
 *
 * Doubling from the right, so the digit nearest the check digit is the first
 * one doubled. A product of ten or more contributes the sum of its own digits,
 * which for a doubled digit is the same as subtracting nine.
 */
function checkDigitOf(payload: string): string {
  let total = 0;
  for (let index = 0; index < payload.length; index++) {
    // Counted from the right, so the rule does not move when the payload's
    // length does.
    const fromRight = payload.length - 1 - index;
    const digit = payload.codePointAt(index)! - 48;
    const doubled = fromRight % 2 === 0 ? digit * 2 : digit;
    total += doubled > 9 ? doubled - 9 : doubled;
  }
  return String((10 - (total % 10)) % 10);
}

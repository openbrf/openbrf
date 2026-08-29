/**
 * The Swedish personal identity number (personnummer), as parsed, normalized,
 * checksum-verified and searched for in free text.
 *
 * These functions live here rather than beside the encryption layer because
 * both sides of the platform need them: the server normalizes before it
 * computes a blind index, and the browser has to be able to say that a piece
 * of text a board member is about to publish carries an identity number before
 * it is sent anywhere. They are pure and dependency-free so that stays true.
 *
 * Normalization is part of the storage format, not a presentation detail. A
 * blind index is a keyed hash of the *normalized* plaintext (ADR 0002), so a
 * lookup only finds a row when the value is normalized identically at write
 * time and at search time:
 *
 *   Changing normalizePersonalIdentityNumber, or the parse it rests on,
 *   invalidates every blind index already stored. Such a change needs a
 *   migration that decrypts each affected field and recomputes its index, and
 *   a bump of the normalization version the encryption layer records.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */

export interface PersonalIdentityNumberParts {
  /** Full four-digit year. */
  year: number;
  month: number;
  /** Day as written, i.e. still carrying the +60 offset for a coordination number. */
  day: number;
  /** The four last digits, including the check digit. */
  suffix: string;
  /** True for a coordination number (samordningsnummer), where day is offset by 60. */
  isCoordinationNumber: boolean;
}

const PERSONAL_IDENTITY_NUMBER_PATTERN =
  /^(?<century>\d{2})?(?<year>\d{2})(?<month>\d{2})(?<day>\d{2})(?<separator>[-+])?(?<suffix>\d{4})$/;

/**
 * Parses a Swedish personal identity number in any of its written forms and
 * returns its parts with the century resolved.
 *
 * Returns null when the input is not shaped like a personal identity number.
 * Shape is not validity: use isValidPersonalIdentityNumber for the checksum.
 *
 * @param referenceDate Date the age is judged against. Injected so tests do
 *   not depend on the current date and so an import can be replayed.
 */
export function parsePersonalIdentityNumber(
  input: string,
  referenceDate: Date = new Date(),
): PersonalIdentityNumberParts | null {
  const compact = input.trim().replace(/\s/g, "");
  const match = PERSONAL_IDENTITY_NUMBER_PATTERN.exec(compact);
  if (match?.groups === undefined) {
    return null;
  }

  const { century, year, month, day, separator, suffix } = match.groups;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    suffix === undefined
  ) {
    return null;
  }

  const twoDigitYear = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);

  let fullYear: number;
  if (century !== undefined) {
    // Written with the century, so take it at face value.
    fullYear = Number(century) * 100 + twoDigitYear;
  } else {
    // Without a century, the most recent year that is not in the future wins,
    // and a plus separator means the person has turned 100.
    const referenceYear = referenceDate.getFullYear();
    fullYear = Math.floor(referenceYear / 100) * 100 + twoDigitYear;
    if (fullYear > referenceYear) {
      fullYear -= 100;
    }
    if (separator === "+") {
      fullYear -= 100;
    }
  }

  const isCoordinationNumber = dayNumber > 60;
  const actualDay = isCoordinationNumber ? dayNumber - 60 : dayNumber;

  if (monthNumber < 1 || monthNumber > 12 || actualDay < 1) {
    return null;
  }
  // A range check alone accepts 30 February and 31 April. Those dates never
  // existed, so a number carrying one is not a mis-typed real number: it is
  // not a personal identity number at all, and a valid Luhn digit must not
  // make it look like one.
  if (actualDay > daysInMonth(fullYear, monthNumber)) {
    return null;
  }

  return {
    year: fullYear,
    month: monthNumber,
    day: dayNumber,
    suffix,
    isCoordinationNumber,
  };
}

/**
 * Canonical form for a personal identity number: twelve digits, no separator
 * (YYYYMMDDNNNN).
 *
 * Returns null when the input is not shaped like a personal identity number,
 * so a caller can reject the row rather than store an index that can never be
 * matched.
 */
export function normalizePersonalIdentityNumber(
  input: string,
  referenceDate: Date = new Date(),
): string | null {
  const parts = parsePersonalIdentityNumber(input, referenceDate);
  if (parts === null) {
    return null;
  }
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${String(parts.year)}${month}${day}${parts.suffix}`;
}

/**
 * Verifies the Luhn check digit, which the last ten digits of a Swedish
 * personal identity number carry.
 *
 * Coordination numbers use the same checksum over the offset day, so no
 * special case is needed here.
 */
export function isValidPersonalIdentityNumber(
  input: string,
  referenceDate: Date = new Date(),
): boolean {
  const normalized = normalizePersonalIdentityNumber(input, referenceDate);
  if (normalized === null) {
    return false;
  }

  // Luhn runs over the ten-digit form: YYMMDDNNNC.
  const tenDigits = normalized.slice(2);
  let sum = 0;
  for (let position = 0; position < 9; position++) {
    const digit = Number(tenDigits[position]);
    const weighted = position % 2 === 0 ? digit * 2 : digit;
    sum += weighted > 9 ? weighted - 9 : weighted;
  }
  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  return expectedCheckDigit === Number(tenDigits[9]);
}

/** One personal identity number found in a piece of text. */
export interface PersonalIdentityNumberMatch {
  /** The number exactly as it is written in the text. */
  value: string;
  /** Offset of the first character of the match within the scanned text. */
  index: number;
}

/**
 * Every candidate shape a personal identity number is written in, unanchored.
 *
 * Ten or twelve digits with an optional separator before the last four. The
 * lookarounds are what keep a longer run of digits - a bank account, a card
 * number, a reference - from yielding a ten-digit window out of its middle:
 * a candidate must not touch a digit on either side.
 *
 * Whitespace inside a number is deliberately not accepted here, although the
 * parser tolerates it in a single value a person typed into a field. In free
 * text a space is a boundary, and honouring it inside a number would let a
 * phone number and the figure after it join into a false match.
 */
const CANDIDATE_PATTERN = /(?<!\d)(?:\d{2})?\d{6}[-+]?\d{4}(?!\d)/g;

/**
 * Finds the personal identity numbers in a piece of free text.
 *
 * Written for the moment before something is published: prose a board member
 * typed, a heading, a caption. Nothing on the association's public website may
 * carry an identity number, and a scanner is what lets the refusal happen at
 * the keyboard rather than after the page is live.
 *
 * Candidates are matched by shape and then put through the same anchored
 * validator a stored value goes through, so the calendar and the Luhn check
 * are what decide. That is what keeps the false-positive rate low enough for
 * the result to be worth refusing on: an invoice number, an amount or a date
 * range has to survive both to be reported.
 *
 * A Swedish organisation number (organisationsnummer) is the same shape and is
 * lawful on a public page - a housing cooperative prints its own in the
 * footer. It is excluded by the calendar check rather than by a special case:
 * the third digit pair of an organisation number is always 20 or more, which
 * is never a month.
 *
 * @param referenceDate Date the century inference is judged against, injected
 *   for the same reason as in the parser.
 */
export function scanForPersonalIdentityNumbers(
  text: string,
  referenceDate: Date = new Date(),
): PersonalIdentityNumberMatch[] {
  const found: PersonalIdentityNumberMatch[] = [];
  // A fresh regex per call: the global flag carries lastIndex, and a shared
  // instance would make one scan depend on the one before it.
  const pattern = new RegExp(CANDIDATE_PATTERN.source, "g");

  let match = pattern.exec(text);
  while (match !== null) {
    const [value] = match;
    if (isValidPersonalIdentityNumber(value, referenceDate)) {
      found.push({ value, index: match.index });
    }
    match = pattern.exec(text);
  }

  return found;
}

/** Days in a month, honouring the Gregorian leap-year rule. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

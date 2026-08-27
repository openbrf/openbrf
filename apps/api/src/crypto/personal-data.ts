/**
 * Normalization of the personal data fields that carry a blind index.
 *
 * A blind index is a keyed hash of the *normalized* plaintext (ADR 0002), so a
 * lookup only finds a row when the value is normalized identically at write
 * time and at search time. That makes these functions part of the storage
 * format, not a presentation detail:
 *
 *   Changing any function here invalidates every blind index already stored.
 *   A change therefore needs a migration that decrypts each affected field and
 *   recomputes its index, and a bump of NORMALIZATION_VERSION below.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */

/**
 * Bumped whenever the normalization rules change. Stored alongside the data so
 * a future migration can tell which rows still hold indexes from an older
 * rule set.
 */
export const NORMALIZATION_VERSION = 1;

/**
 * Canonical form for email: trimmed and lowercased.
 *
 * The local part of an address is technically case-sensitive, but no mail
 * provider in practice treats it that way, and a blind index needs exactly one
 * canonical form to match on. Lowercasing is therefore deliberate.
 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Canonical form for a phone number: E.164 where the country is known.
 *
 * Swedish numbers are the common case and reach the register in every possible
 * shape ("070-123 45 67", "0046701234567", "+46 70 123 45 67"). All of them
 * must land on the same index or searching by phone silently fails.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    return "";
  }

  // Keep a leading plus, drop every other non-digit (spaces, dashes,
  // parentheses, non-breaking spaces pasted from spreadsheets).
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") {
    return "";
  }

  if (hasPlus) {
    return `+${digits}`;
  }
  // International prefix written as 00.
  if (digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }
  // Swedish national format: a single leading zero is the trunk prefix.
  if (digits.startsWith("0")) {
    return `+46${digits.slice(1)}`;
  }
  // No country and no trunk prefix: assume Sweden, which is what a
  // spreadsheet that ate the leading zero produces.
  return `+46${digits}`;
}

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

  if (monthNumber < 1 || monthNumber > 12 || actualDay < 1 || actualDay > 31) {
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

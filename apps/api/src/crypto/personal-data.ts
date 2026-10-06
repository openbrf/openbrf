/**
 * Normalization of the personal data fields that carry a blind index.
 *
 * A blind index is a keyed hash of the *normalized* plaintext (ADR 0002), so a
 * lookup only finds a row when the value is normalized identically at write
 * time and at search time. That makes these functions part of the storage
 * format, not a presentation detail:
 *
 *   Changing any function here invalidates every blind index already stored.
 *   A change therefore bumps NORMALIZATION_VERSION below, together with a
 *   migration that moves the default of person.blindIndexVersion to it, and
 *   PersonReindexService recomputes the older rows' indexes at the next boot.
 *
 * The personal identity number's own parse, normalization and checksum live in
 * `@openbrf/shared` and are re-exported below, because the browser needs them
 * as well: text about to be published has to be checked for an identity number
 * before it is sent. They carry the same warning there, and the version below
 * covers them.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */

export {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
  parsePersonalIdentityNumber,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";
export type {
  PersonalIdentityNumberMatch,
  PersonalIdentityNumberParts,
} from "@openbrf/shared";

/**
 * Bumped whenever the normalization rules change. Stored on each person row
 * (blindIndexVersion), so the reindex at boot can tell which rows still hold
 * indexes from an older rule set.
 *
 * 2: a ten-digit identity number's century is judged by the whole birth date,
 * and a phone number's trunk zero after +46 is dropped.
 */
export const NORMALIZATION_VERSION = 2;

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
    return withoutTrunkZero(`+${digits}`);
  }
  // International prefix written as 00.
  if (digits.startsWith("00")) {
    return withoutTrunkZero(`+${digits.slice(2)}`);
  }
  // Swedish national format: a single leading zero is the trunk prefix.
  if (digits.startsWith("0")) {
    return `+46${digits.slice(1)}`;
  }
  // No country and no trunk prefix: assume Sweden, which is what a
  // spreadsheet that ate the leading zero produces.
  return `+46${digits}`;
}

/**
 * A Swedish number with its trunk zero left beside the country code.
 *
 * "+46 (0)70 123 45 67" is a common way to write a number for readers at home
 * and abroad at once, and it reaches here as +460701234567. No Swedish number
 * continues with a zero after +46, so the zero is the trunk prefix and goes:
 * otherwise this spelling and "070-123 45 67" would be two indexes for one
 * phone.
 */
function withoutTrunkZero(international: string): string {
  return international.replace(/^\+460/, "+46");
}

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

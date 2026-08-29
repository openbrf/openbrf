export {
  apartmentNumberFor,
  ApartmentNumberingError,
  ENTRANCE_FLOOR_PREFIX,
  floorOfApartmentNumber,
  generateApartmentNumbers,
  HIGHEST_FLOOR,
  LOWEST_FLOOR,
  MAX_APARTMENTS_PER_FLOOR,
} from "./apartment-numbering.ts";
export type {
  ApartmentNumberRow,
  GenerateApartmentNumbersInput,
} from "./apartment-numbering.ts";
export {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
  parsePersonalIdentityNumber,
  scanForPersonalIdentityNumbers,
} from "./personal-identity-number.ts";
export type {
  PersonalIdentityNumberMatch,
  PersonalIdentityNumberParts,
} from "./personal-identity-number.ts";

/** Placeholder version constant until the first release is cut via changesets. */
export const VERSION = "0.0.0";

/**
 * Minimal typed Result helper for explicit error handling without exceptions.
 * Domain services return Result instead of throwing for expected failures.
 */
export type Result<T, E = Error> =
  { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * What the database is asked for, per audience.
 *
 * These projections are a security boundary, not a performance detail. The
 * masking rules in address-book-view.ts are the last gate before serialisation;
 * these are the first, and they work by not loading what the viewer may not
 * see. A resident's response cannot leak an encrypted contact field if the
 * ciphertext was never selected, so a mistake downstream has nothing to leak.
 *
 * Kept in their own module, free of Nest and Prisma imports, so the invariant
 * below can be asserted directly in a unit test.
 */

/** Suffix marking an encrypted column, per the schema's naming convention. */
export const ENCRYPTED_COLUMN_SUFFIX = "Cipher";

/** Suffix marking a blind index column. */
export const BLIND_INDEX_COLUMN_SUFFIX = "Index";

/**
 * The board and admin projection.
 *
 * Loads the email and phone ciphertext, which the service decrypts unless the
 * person carries protected personal data. It deliberately does NOT load
 * personalIdentityNumberCipher: no list row carries a personal identity number,
 * and the audited reveal loads it on its own.
 */
export const BOARD_PERSON_FIELDS = {
  id: true,
  firstName: true,
  lastName: true,
  protectedPersonalData: true,
  emailCipher: true,
  phoneCipher: true,
} as const;

/**
 * The resident-facing projection: no encrypted column at all.
 *
 * Residents never see another resident's email or phone (plan 4.4, settled
 * 2026-08-27), so there is nothing here to decrypt.
 * `protectedPersonalData` is loaded only so the exclusion rule can be asserted a
 * second time in application code.
 */
export const RESIDENT_PERSON_FIELDS = {
  id: true,
  firstName: true,
  lastName: true,
  protectedPersonalData: true,
} as const;

export const APARTMENT_FIELDS = {
  id: true,
  addressId: true,
  number: true,
  floor: true,
} as const;

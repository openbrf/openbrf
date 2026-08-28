import { describe, expect, it } from "vitest";

import {
  BLIND_INDEX_COLUMN_SUFFIX,
  BOARD_PERSON_FIELDS,
  ENCRYPTED_COLUMN_SUFFIX,
  RESIDENT_PERSON_FIELDS,
} from "./address-book-projection";

/**
 * The projections as an invariant.
 *
 * These assertions look structural because the property they defend is
 * structural: the resident-facing query must not be able to load an encrypted
 * column, and the list query must not be able to load a personal identity
 * number. Both are enforced by what the SELECT asks for, and a test on the
 * response alone cannot see the difference - the masking layer downstream hides
 * a wrongly loaded value, which is exactly why that layer must not be the only
 * one working.
 */

const encryptedColumns = (fields: Record<string, unknown>): string[] =>
  Object.keys(fields).filter(
    (key) =>
      key.endsWith(ENCRYPTED_COLUMN_SUFFIX) ||
      key.endsWith(BLIND_INDEX_COLUMN_SUFFIX),
  );

describe("the resident-facing projection", () => {
  it("loads no encrypted column and no blind index", () => {
    // Residents never see another resident's email or phone. Not loading the
    // ciphertext means a mapping mistake downstream has nothing to leak.
    expect(encryptedColumns(RESIDENT_PERSON_FIELDS)).toEqual([]);
  });

  it("loads only names, the person id and the protected flag", () => {
    expect(Object.keys(RESIDENT_PERSON_FIELDS).sort()).toEqual([
      "firstName",
      "id",
      "lastName",
      "protectedPersonalData",
    ]);
  });
});

describe("the board projection", () => {
  it("loads email and phone, which the board is entitled to see", () => {
    expect(encryptedColumns(BOARD_PERSON_FIELDS).sort()).toEqual([
      "emailCipher",
      "phoneCipher",
    ]);
  });

  it("never loads a personal identity number for a list", () => {
    // DESIGN.md keeps a personal identity number out of every view but the
    // register ones, and the audited reveal loads it on its own.
    expect(Object.keys(BOARD_PERSON_FIELDS)).not.toContain(
      "personalIdentityNumberCipher",
    );
    expect(Object.keys(BOARD_PERSON_FIELDS)).not.toContain(
      "personalIdentityNumberIndex",
    );
  });
});

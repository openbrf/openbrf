import { beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { FieldEncryptionService } from "./field-encryption.service";

/**
 * Exercises the real cryptography rather than a mock: the properties under
 * test (a stable index, a randomized ciphertext, a decryptable round trip) are
 * exactly what a mock would fake away, and they are what the address book's
 * search depends on.
 */

const TEST_ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgresql://unused",
  APP_URL: "http://localhost:5173",
  OPENBRF_DATA_DIR: "./.data",
  // Fixed key so the suite never touches the filesystem or generates one.
  OPENBRF_ENCRYPTION_KEY: "a".repeat(64),
  BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
  OPENBRF_PLUGINS_ENABLED: false,
  OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
  DATABASE_URL_RUNTIME: undefined,
  OPENBRF_CATALOG_URL: undefined,
  OPENBRF_CATALOG_TOKEN: undefined,
};

describe("FieldEncryptionService", () => {
  let service: FieldEncryptionService;

  beforeAll(() => {
    service = new FieldEncryptionService(TEST_ENV);
  });

  it("round-trips a value back to exactly what was entered", async () => {
    const { cipher } = await service.encrypt(
      "person.email",
      "Anna.Lindqvist@Exempel.SE",
    );

    // The ciphertext preserves the original spelling, not the normalized form:
    // the register prints what the resident wrote.
    await expect(service.decrypt("person.email", cipher)).resolves.toBe(
      "Anna.Lindqvist@Exempel.SE",
    );
  });

  it("produces a different ciphertext each time for the same input", async () => {
    const first = await service.encrypt("person.email", "anna@exempel.se");
    const second = await service.encrypt("person.email", "anna@exempel.se");

    expect(first.cipher).not.toBe(second.cipher);
  });

  it("produces a stable blind index for the same input", async () => {
    const first = await service.encrypt("person.email", "anna@exempel.se");
    const second = await service.encrypt("person.email", "anna@exempel.se");

    expect(first.index).toBe(second.index);
    expect(first.index).not.toBeNull();
  });

  it("indexes different values differently", async () => {
    const anna = await service.encrypt("person.email", "anna@exempel.se");
    const erik = await service.encrypt("person.email", "erik@exempel.se");

    expect(anna.index).not.toBe(erik.index);
  });

  it("finds a stored value when the search spells it differently", async () => {
    // Stored as the resident typed it.
    const stored = await service.encrypt("person.phone", "070-123 45 67");
    // Searched in another spelling entirely.
    const searched = await service.computeIndex("person.phone", "+46701234567");

    expect(searched).toBe(stored.index);
  });

  it("matches a personal identity number written with or without the century", async () => {
    const stored = await service.encrypt(
      "person.personalIdentityNumber",
      "811228-9874",
    );
    const searched = await service.computeIndex(
      "person.personalIdentityNumber",
      "198112289874",
    );

    expect(searched).toBe(stored.index);
  });

  it("returns a null index for a value that cannot be normalized", async () => {
    const { cipher, index } = await service.encrypt(
      "person.personalIdentityNumber",
      "not a number",
    );

    // Still encrypted, so nothing is lost, but deliberately unsearchable
    // rather than indexed under a value no lookup could reproduce.
    expect(index).toBeNull();
    await expect(
      service.decrypt("person.personalIdentityNumber", cipher),
    ).resolves.toBe("not a number");
  });

  it("does not index a field declared as unindexed", async () => {
    const { cipher, index } = await service.encrypt(
      "association.smtpPassword",
      "smtp-secret",
    );

    expect(index).toBeNull();
    await expect(
      service.decrypt("association.smtpPassword", cipher),
    ).resolves.toBe("smtp-secret");
  });

  it("keeps fields cryptographically separate across tables", async () => {
    const personIndex = await service.computeIndex(
      "person.email",
      "anna@exempel.se",
    );
    const signupIndex = await service.computeIndex(
      "signupRequest.email",
      "anna@exempel.se",
    );

    // Per-field key derivation means the two indexes are not comparable. Code
    // that checks a signup request against existing persons must compute a
    // person.email index from the plaintext instead of comparing these.
    expect(personIndex).not.toBe(signupIndex);
  });

  it("cannot decrypt a value under a different field identity", async () => {
    const { cipher } = await service.encrypt("person.email", "anna@exempel.se");

    await expect(
      service.decrypt("signupRequest.email", cipher),
    ).rejects.toThrow();
  });

  it("cannot decrypt with a different key", async () => {
    const { cipher } = await service.encrypt("person.email", "anna@exempel.se");
    const otherService = new FieldEncryptionService({
      ...TEST_ENV,
      OPENBRF_ENCRYPTION_KEY: "b".repeat(64),
    });

    await expect(
      otherService.decrypt("person.email", cipher),
    ).rejects.toThrow();
  });
});

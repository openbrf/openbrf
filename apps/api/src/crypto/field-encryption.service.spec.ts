import { createHash } from "node:crypto";
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
  OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE: 60,
  OPENBRF_ACTIONS_READ_ONLY: false,
  OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
  OPENBRF_PLUGINS_REINSTALL_ON_BOOT: false,
  DATABASE_URL_RUNTIME: undefined,
  OPENBRF_CATALOG_URL: undefined,
  OPENBRF_CATALOG_TOKEN: undefined,
  OPENBRF_STORAGE_DRIVER: "local",
  OPENBRF_S3_ENDPOINT: undefined,
  OPENBRF_S3_REGION: "us-east-1",
  OPENBRF_S3_BUCKET: undefined,
  OPENBRF_S3_ACCESS_KEY_ID: undefined,
  OPENBRF_S3_SECRET_ACCESS_KEY: undefined,
  OPENBRF_S3_FORCE_PATH_STYLE: false,
  OPENBRF_MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
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

  it("round-trips a stored file's key and computes no index for it", async () => {
    const key = "0123456789abcdef".repeat(4);

    const { cipher, index } = await service.encrypt("mediaFile.dataKey", key);

    // Read back by primary key alone: an index of a key would be a second
    // copy of something that is only worth anything secret.
    expect(index).toBeNull();
    expect(cipher.startsWith("brng:")).toBe(true);
    await expect(service.decrypt("mediaFile.dataKey", cipher)).resolves.toBe(
      key,
    );
  });

  describe("a stored file's checksum", () => {
    const file = Buffer.from("%PDF-1.7 the association's bylaws", "latin1");

    it("is 256 bits, hex encoded", async () => {
      await expect(service.storedFileChecksum(file)).resolves.toMatch(
        /^[0-9a-f]{64}$/,
      );
    });

    it("is the same for the same bytes, so it can stand as the entity tag", async () => {
      await expect(service.storedFileChecksum(file)).resolves.toBe(
        await service.storedFileChecksum(Buffer.from(file)),
      );
    });

    it("differs for bytes that differ by one bit", async () => {
      const changed = Buffer.from(file);
      changed[0] = (changed[0] ?? 0) ^ 0x01;

      expect(await service.storedFileChecksum(changed)).not.toBe(
        await service.storedFileChecksum(file),
      );
    });

    it("cannot be computed from the file alone", async () => {
      /*
       * The property the keyed hash exists for. A plain SHA-256 lets anybody
       * holding the database confirm that a document they already have is
       * stored here; this one needs the instance's key.
       */
      const otherInstance = new FieldEncryptionService({
        ...TEST_ENV,
        OPENBRF_ENCRYPTION_KEY: "b".repeat(64),
      });
      const checksum = await service.storedFileChecksum(file);

      expect(checksum).not.toBe(
        createHash("sha256").update(file).digest("hex"),
      );
      expect(checksum).not.toBe(await otherInstance.storedFileChecksum(file));
    });

    it("takes every byte of a binary file as it is", async () => {
      // A file is bytes, not text: two files that decode to the same string
      // under a text encoding must still be told apart.
      const first = Buffer.from([0x80, 0x00, 0xff]);
      const second = Buffer.from([0x81, 0x00, 0xff]);

      expect(await service.storedFileChecksum(first)).not.toBe(
        await service.storedFileChecksum(second),
      );
    });
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

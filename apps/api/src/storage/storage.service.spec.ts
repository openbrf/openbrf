import { describe, expect, it } from "vitest";

import { loadEnv } from "../config/env";
import { LocalDiskStorageDriver } from "./local-disk.driver";
import { S3StorageDriver } from "./s3.driver";
import { generateStorageKey } from "./storage-key";
import { createDriver } from "./storage.service";

/**
 * Choosing a storage backend, and naming what goes into it.
 *
 * The configuration is the part an operator gets wrong, and both failure modes
 * here are quiet ones: a half-configured bucket that looks healthy until the
 * first upload, and a key built from something a client supplied.
 */

const BASE = {
  DATABASE_URL: "postgresql://unused",
  BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
} as const;

describe("choosing the driver", () => {
  it("writes to the data volume by default", () => {
    const env = loadEnv({ ...BASE });

    expect(env.OPENBRF_STORAGE_DRIVER).toBe("local");
    expect(createDriver(env)).toBeInstanceOf(LocalDiskStorageDriver);
  });

  it("uses the bucket when one is configured", () => {
    const env = loadEnv({
      ...BASE,
      OPENBRF_STORAGE_DRIVER: "s3",
      OPENBRF_S3_ENDPOINT: "https://s3.example.net",
      OPENBRF_S3_BUCKET: "openbrf",
      OPENBRF_S3_ACCESS_KEY_ID: "key",
      OPENBRF_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(createDriver(env)).toBeInstanceOf(S3StorageDriver);
  });

  it("refuses to boot on a half-configured bucket, naming what is missing", () => {
    /*
     * At boot rather than at the first upload. An instance that starts with
     * half a storage configuration looks healthy until somebody uploads a file,
     * and by then the operator is debugging an upload rather than reading an
     * error that names the variable.
     */
    const attempt = () =>
      loadEnv({
        ...BASE,
        OPENBRF_STORAGE_DRIVER: "s3",
        OPENBRF_S3_ENDPOINT: "https://s3.example.net",
      });

    expect(attempt).toThrow(/OPENBRF_S3_BUCKET/);
    expect(attempt).toThrow(/OPENBRF_S3_ACCESS_KEY_ID/);
    expect(attempt).toThrow(/OPENBRF_S3_SECRET_ACCESS_KEY/);
  });

  it("ignores bucket settings while the local driver is selected", () => {
    const env = loadEnv({ ...BASE, OPENBRF_S3_BUCKET: "left-over" });

    expect(createDriver(env)).toBeInstanceOf(LocalDiskStorageDriver);
  });

  it("refuses an upload limit past the ceiling", () => {
    // The limit is what stops a request filling the disk, so a mistyped value
    // has removed the protection rather than relaxed it.
    expect(() =>
      loadEnv({ ...BASE, OPENBRF_MAX_UPLOAD_BYTES: "999999999999" }),
    ).toThrow(/OPENBRF_MAX_UPLOAD_BYTES/);
  });
});

describe("naming an object", () => {
  it("groups by owner and month, and ends in a random identifier", () => {
    const key = generateStorageKey(
      "branding",
      "image/png",
      new Date("2026-08-28T00:00:00.000Z"),
    );

    expect(key).toMatch(/^branding\/2026\/08\/[0-9a-f-]{36}\.png$/);
  });

  it("never repeats a key for the same file", () => {
    const first = generateStorageKey("media", "image/png");
    const second = generateStorageKey("media", "image/png");

    expect(first).not.toBe(second);
  });

  it("takes the extension from the identified type, not from any name", () => {
    expect(generateStorageKey("media", "image/jpeg")).toMatch(/\.jpg$/);
    expect(generateStorageKey("media", "image/webp")).toMatch(/\.webp$/);
  });
});

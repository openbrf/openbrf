import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { formatSha512, IntegrityError, parseSha512 } from "./integrity.ts";

/**
 * The instance and the catalog's own check both read a catalog entry's digest
 * through parseSha512, so what it accepts is what a listing may say. Two
 * invariants are protected here.
 *
 * Both spellings of a digest must mean the same 64 bytes, because a publisher
 * has one of them to hand and transcribing to the other by hand is how a
 * catalog entry ends up wrong in a way nobody notices until an install fails.
 *
 * A refusal must be identifiable by its `reason`, because that is what the
 * installer branches on. Message text is not part of that contract and is not
 * asserted.
 *
 * The codec is written without `Buffer`, so it is also held to what `Buffer`
 * produces for the same bytes.
 */

const DIGEST = new Uint8Array(
  createHash("sha512").update("the bytes of a plugin tarball").digest(),
);
const SRI_FORM = formatSha512(DIGEST);
const HEX_FORM = Buffer.from(DIGEST).toString("hex");

function refusalReason(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof IntegrityError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error("The call was expected to throw an IntegrityError.");
}

describe("parseSha512", () => {
  it("accepts the subresource-integrity form", () => {
    expect(parseSha512(SRI_FORM)).toEqual(DIGEST);
  });

  it("accepts the 128-character hex form", () => {
    expect(parseSha512(HEX_FORM)).toEqual(DIGEST);
  });

  it("reads the same 64 bytes from either spelling", () => {
    // The two forms are what "npm pack --json" and "sha512sum" each report for
    // the same tarball, so they have to be interchangeable in a catalog entry.
    expect(parseSha512(SRI_FORM)).toEqual(parseSha512(HEX_FORM));
  });

  it("accepts hex in upper case", () => {
    expect(parseSha512(HEX_FORM.toUpperCase())).toEqual(DIGEST);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseSha512(`  ${SRI_FORM}\n`)).toEqual(DIGEST);
  });

  it("accepts a digest whose base64 padding is left off", () => {
    // Buffer reads it, and a publisher who trims the "==" has not made the
    // digest any less theirs.
    expect(SRI_FORM.endsWith("==")).toBe(true);
    expect(parseSha512(SRI_FORM.slice(0, -2))).toEqual(DIGEST);
  });

  it("ignores non-zero bits after the last whole byte", () => {
    // 64 bytes leave four spare bits in the final base64 character. Buffer
    // discards them, so a spelling that sets them still names the same digest.
    const body = SRI_FORM.slice("sha512-".length, -2);
    const last = body.slice(-1);
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const sloppy = `${body.slice(0, -1)}${alphabet.charAt(alphabet.indexOf(last) + 1)}==`;
    expect(Buffer.from(sloppy, "base64")).toEqual(Buffer.from(DIGEST));
    expect(parseSha512(`sha512-${sloppy}`)).toEqual(DIGEST);
  });

  it("rejects a base64 digest that is not 64 bytes", () => {
    // A truncated digest still matches the shape of the SRI form, so the byte
    // length is the only thing that catches it.
    const truncated = formatSha512(DIGEST.subarray(0, 32));
    expect(refusalReason(() => parseSha512(truncated))).toBe(
      "malformed-digest",
    );
  });

  it.each([
    ["a non-hex string of the right length", "z".repeat(128)],
    ["an empty string", ""],
    ["only whitespace", "   "],
    [
      "a sha256 prefix",
      `sha256-${Buffer.from(DIGEST.subarray(0, 32)).toString("base64")}`,
    ],
    ["hex one character short", HEX_FORM.slice(0, 127)],
    ["a bare word", "not-a-digest"],
  ])("rejects %s", (_label, declared) => {
    expect(refusalReason(() => parseSha512(declared))).toBe("malformed-digest");
  });

  it("reads random digests as Buffer does", () => {
    for (let round = 0; round < 50; round += 1) {
      const bytes = randomBytes(64);
      const sri = `sha512-${bytes.toString("base64")}`;
      expect(Buffer.from(parseSha512(sri))).toEqual(bytes);
      expect(Buffer.from(parseSha512(bytes.toString("hex")))).toEqual(bytes);
    }
  });
});

describe("formatSha512", () => {
  it("spells a digest as Buffer does", () => {
    for (let round = 0; round < 50; round += 1) {
      const bytes = randomBytes(64);
      expect(formatSha512(bytes)).toBe(`sha512-${bytes.toString("base64")}`);
    }
  });

  it.each([0, 1, 2, 3, 4, 5])("pads a %i-byte input correctly", (length) => {
    const bytes = randomBytes(length);
    expect(formatSha512(bytes)).toBe(`sha512-${bytes.toString("base64")}`);
  });

  it("round-trips through parseSha512", () => {
    expect(parseSha512(formatSha512(DIGEST))).toEqual(DIGEST);
  });
});

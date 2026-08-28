import { describe, expect, it } from "vitest";

import {
  formatSha512,
  IntegrityError,
  parseSha512,
  sha512,
  verifySha512,
} from "./integrity";

/**
 * The digest is the whole trust model for the bytes of a downloaded tarball:
 * the catalog is curated and served over TLS, the tarball itself may live on
 * another host, and nothing is signed. Two invariants are protected here.
 *
 * Both spellings of a digest must mean the same 64 bytes, because a publisher
 * has one of them to hand and transcribing to the other by hand is how a
 * catalog entry ends up wrong in a way nobody notices until an install fails.
 *
 * A refusal must be identifiable by its `reason`, because that is what the
 * installer branches on to tell "the catalog entry is wrong" apart from "the
 * bytes that arrived are not the bytes the catalog named". Message text is not
 * part of that contract and is not asserted.
 */

const BYTES = Buffer.from("the bytes of a plugin tarball", "utf8");
const DIGEST = sha512(BYTES);
const SRI_FORM = formatSha512(DIGEST);
const HEX_FORM = DIGEST.toString("hex");

/** The reason of the IntegrityError a call raises; fails if it raises none. */
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
    expect(parseSha512(SRI_FORM)).toHaveLength(64);
  });

  it("accepts the 128-character hex form", () => {
    expect(parseSha512(HEX_FORM)).toHaveLength(64);
  });

  it("reads the same 64 bytes from either spelling", () => {
    // The two forms are what "npm pack --json" and "sha512sum" each report for
    // the same tarball, so they have to be interchangeable in a catalog entry.
    expect(parseSha512(SRI_FORM).equals(parseSha512(HEX_FORM))).toBe(true);
    expect(parseSha512(SRI_FORM).equals(DIGEST)).toBe(true);
  });

  it("accepts hex in upper case", () => {
    expect(parseSha512(HEX_FORM.toUpperCase()).equals(DIGEST)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseSha512(`  ${SRI_FORM}\n`).equals(DIGEST)).toBe(true);
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
    ["a sha256 prefix", `sha256-${DIGEST.subarray(0, 32).toString("base64")}`],
    ["hex one character short", HEX_FORM.slice(0, 127)],
    ["a bare word", "not-a-digest"],
  ])("rejects %s", (_label, declared) => {
    expect(refusalReason(() => parseSha512(declared))).toBe("malformed-digest");
  });

  it("round-trips a formatted digest", () => {
    expect(parseSha512(formatSha512(sha512(BYTES))).equals(DIGEST)).toBe(true);
  });
});

describe("verifySha512", () => {
  it("passes for bytes that hash to the declared digest", () => {
    expect(() => {
      verifySha512(BYTES, SRI_FORM);
    }).not.toThrow();
  });

  it("passes whichever spelling the catalog used", () => {
    expect(() => {
      verifySha512(BYTES, HEX_FORM);
    }).not.toThrow();
  });

  it("refuses a single flipped byte", () => {
    // One flipped byte is the whole point: a tarball that is nearly right is
    // discarded rather than unpacked, and the caller can tell that apart from a
    // digest the catalog wrote badly.
    const tampered = Buffer.from(BYTES);
    tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);

    expect(
      refusalReason(() => {
        verifySha512(tampered, SRI_FORM);
      }),
    ).toBe("digest-mismatch");
  });

  it("refuses bytes appended to the end", () => {
    const extended = Buffer.concat([BYTES, Buffer.from([0])]);
    expect(
      refusalReason(() => {
        verifySha512(extended, SRI_FORM);
      }),
    ).toBe("digest-mismatch");
  });

  it("reports a malformed declaration rather than a mismatch", () => {
    // The installer shows these differently: one is a broken catalog entry, the
    // other is a tarball that must not be unpacked.
    expect(
      refusalReason(() => {
        verifySha512(BYTES, "sha512-nonsense");
      }),
    ).toBe("malformed-digest");
  });
});

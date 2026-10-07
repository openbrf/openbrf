import { formatSha512, IntegrityError, parseSha512 } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vitest";

import { sha512, verifySha512 } from "./integrity";

/**
 * The digest is the whole trust model for the bytes of a downloaded tarball:
 * the catalog is curated and served over TLS, the tarball itself may live on
 * another host, and nothing is signed. What is protected here is that a
 * refusal is identifiable by its `reason`, because that is what the installer
 * branches on to tell "the catalog entry is wrong" apart from "the bytes that
 * arrived are not the bytes the catalog named". Message text is not part of
 * that contract and is not asserted. Reading the two digest spellings is the
 * SDK's, and is tested there.
 */

const BYTES = Buffer.from("the bytes of a plugin tarball", "utf8");
const OTHER_BYTES = Buffer.from("a substituted tarball", "utf8");
const DIGEST = sha512(BYTES);
const SRI_FORM = formatSha512(DIGEST);
const HEX_FORM = DIGEST.toString("hex");

/**
 * Runs `run` and asserts it was refused with an IntegrityError carrying this
 * reason. The class is checked as well as the reason: the installer tells the
 * two apart with `instanceof`, which a plain Error that merely carries a
 * `reason` would not satisfy.
 */
function expectRefusal(
  run: () => unknown,
  reason: IntegrityError["reason"],
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(IntegrityError);
  expect(thrown).toHaveProperty("reason", reason);
}

describe("verifySha512", () => {
  /*
   * Acceptance is asserted together with the refusal of the same declaration
   * against different bytes. On its own, "did not throw" is satisfied by a
   * verify that compares nothing at all - which is the one implementation this
   * function must never be allowed to become, since the digest is the whole
   * trust model for a tarball arriving from a host the catalog only points at.
   */
  it.each([
    ["the subresource-integrity spelling", SRI_FORM],
    ["the hex spelling", HEX_FORM],
  ])("accepts exactly the bytes named in %s", (_label, declared) => {
    expect(Buffer.from(parseSha512(declared)).equals(sha512(BYTES))).toBe(true);

    expect(() => {
      verifySha512(BYTES, declared);
    }).not.toThrow();

    expectRefusal(() => {
      verifySha512(OTHER_BYTES, declared);
    }, "digest-mismatch");
  });

  it("refuses a single flipped byte", () => {
    // One flipped byte is the whole point: a tarball that is nearly right is
    // discarded rather than unpacked, and the caller can tell that apart from a
    // digest the catalog wrote badly.
    const tampered = Buffer.from(BYTES);
    tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);

    expectRefusal(() => {
      verifySha512(tampered, SRI_FORM);
    }, "digest-mismatch");
  });

  it("refuses bytes appended to the end", () => {
    const extended = Buffer.concat([BYTES, Buffer.from([0])]);
    expectRefusal(() => {
      verifySha512(extended, SRI_FORM);
    }, "digest-mismatch");
  });

  it("reports a malformed declaration rather than a mismatch", () => {
    // The installer shows these differently: one is a broken catalog entry, the
    // other is a tarball that must not be unpacked.
    expectRefusal(() => {
      verifySha512(BYTES, "sha512-nonsense");
    }, "malformed-digest");
  });
});

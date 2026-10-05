import { createHash, timingSafeEqual } from "node:crypto";

import { formatSha512, IntegrityError, parseSha512 } from "@openbrf/plugin-sdk";

/**
 * Tarball integrity.
 *
 * The catalog names a direct tarball URL and its sha512 (plan section 5). The
 * digest is the whole of the trust model for the bytes that arrive: the
 * catalog is curated and served over TLS, the tarball may be a release asset
 * on another host, and nothing is signed in v1. So the check is not optional
 * and not a warning - a tarball whose digest does not match the catalog is
 * discarded, never unpacked.
 *
 * Shared by the plugin installer and the theme installer, which run the same
 * download-and-verify path against the same catalog format. Reading a digest is
 * not done here: `parseSha512` comes from the plugin SDK, so the catalog's own
 * check accepts exactly the spellings this does.
 */

export function sha512(bytes: Uint8Array): Buffer {
  return createHash("sha512").update(bytes).digest();
}

/**
 * Throws unless the bytes hash to the declared digest.
 *
 * Compared in constant time. The digest is public and an attacker who can
 * substitute the tarball does not need a timing oracle to do it, so this is
 * not load-bearing - it is here so that a later use of this function against
 * a secret does not have to remember to change the comparison.
 */
export function verifySha512(bytes: Uint8Array, declared: string): void {
  const expected = parseSha512(declared);
  const actual = sha512(bytes);

  if (!timingSafeEqual(expected, actual)) {
    throw new IntegrityError(
      `Digest mismatch: the catalog declares ${formatSha512(expected)}, ` +
        `the downloaded archive is ${formatSha512(actual)}.`,
      "digest-mismatch",
    );
  }
}

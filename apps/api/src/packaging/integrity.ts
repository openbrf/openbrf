import { createHash, timingSafeEqual } from "node:crypto";

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
 * download-and-verify path against the same catalog format.
 */

/** How the catalog may write a digest. */
const SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const HEX_PATTERN = /^[0-9a-f]{128}$/i;

export class IntegrityError extends Error {
  constructor(
    message: string,
    readonly reason: "malformed-digest" | "digest-mismatch",
  ) {
    super(message);
    this.name = "IntegrityError";
  }
}

/**
 * Normalizes a declared digest to raw bytes.
 *
 * Both spellings are accepted because both are what a publisher actually has
 * to hand: `npm pack --json` reports the subresource-integrity form
 * (`sha512-<base64>`), while `sha512sum` prints hex. Requiring one would mean
 * every catalog entry is transcribed by hand from the other, which is how a
 * digest ends up wrong in a way nobody notices until an install fails.
 */
export function parseSha512(declared: string): Buffer {
  const trimmed = declared.trim();

  const sri = SRI_PATTERN.exec(trimmed);
  if (sri !== null) {
    const bytes = Buffer.from(sri[1] ?? "", "base64");
    if (bytes.length !== 64) {
      throw new IntegrityError(
        "A sha512 digest is 64 bytes; this one is not.",
        "malformed-digest",
      );
    }
    return bytes;
  }

  if (HEX_PATTERN.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  throw new IntegrityError(
    'Expected a digest written as "sha512-<base64>" or 128 hex characters.',
    "malformed-digest",
  );
}

/** The subresource-integrity spelling, which is what a catalog entry carries. */
export function formatSha512(digest: Buffer): string {
  return `sha512-${digest.toString("base64")}`;
}

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

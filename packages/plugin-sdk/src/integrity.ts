/**
 * How a catalog entry spells the sha512 digest of its tarball.
 *
 * The instance verifies the digest before it unpacks a download, and the
 * catalog's own check verifies it before a listing is merged. Both must accept
 * exactly the same spellings, or the catalog passes an entry the instance then
 * refuses. So the parsing lives here, in the contract both depend on, and
 * nowhere else.
 *
 * Written without `Buffer`, `atob` or `node:crypto`: this package is bundled
 * into places that have none of them (see package-check.ts), and hashing
 * itself stays with the caller.
 */

const SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const HEX_PATTERN = /^[0-9a-f]{128}$/i;

const SHA512_BYTES = 64;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Why a digest was refused. `malformed-digest` is a catalog entry that is
 * written wrongly; `digest-mismatch` is bytes that are not the ones the entry
 * names. Installers branch on the difference.
 */
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
 *
 * @throws IntegrityError with reason `malformed-digest`.
 */
export function parseSha512(declared: string): Uint8Array {
  const trimmed = declared.trim();

  const sri = SRI_PATTERN.exec(trimmed);
  if (sri !== null) {
    const bytes = fromBase64(sri[1] ?? "");
    if (bytes.length !== SHA512_BYTES) {
      throw new IntegrityError(
        "A sha512 digest is 64 bytes; this one is not.",
        "malformed-digest",
      );
    }
    return bytes;
  }

  if (HEX_PATTERN.test(trimmed)) {
    return fromHex(trimmed);
  }

  throw new IntegrityError(
    'Expected a digest written as "sha512-<base64>" or 128 hex characters.',
    "malformed-digest",
  );
}

/** The subresource-integrity spelling, which is what a catalog entry carries. */
export function formatSha512(digest: Uint8Array): string {
  return `sha512-${toBase64(digest)}`;
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Standard base64; padding is optional, as `Buffer.from(_, "base64")` reads it. */
function fromBase64(encoded: string): Uint8Array {
  const characters = encoded.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((characters.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let written = 0;

  for (const character of characters) {
    accumulator = (accumulator << 6) | BASE64_ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >> bits) & 0xff;
      written += 1;
      accumulator &= (1 << bits) - 1;
    }
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const group = (first << 16) | (second << 8) | third;
    const remaining = bytes.length - index;

    encoded += BASE64_ALPHABET.charAt((group >> 18) & 63);
    encoded += BASE64_ALPHABET.charAt((group >> 12) & 63);
    encoded += remaining > 1 ? BASE64_ALPHABET.charAt((group >> 6) & 63) : "=";
    encoded += remaining > 2 ? BASE64_ALPHABET.charAt(group & 63) : "=";
  }
  return encoded;
}

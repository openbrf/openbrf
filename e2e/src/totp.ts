import { createHmac } from "node:crypto";

/**
 * A TOTP code, from the otpauth:// URI the security settings show.
 *
 * RFC 6238 in twenty lines rather than a dependency: the algorithm is fixed,
 * the suite needs one direction of it, and an authenticator app is exactly what
 * the test is standing in for.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(input: string): Buffer {
  const cleaned = input.replaceAll("=", "").replaceAll(" ", "").toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of cleaned) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value === -1) {
      throw new Error(`"${character}" is not a base32 character`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

export type TotpParameters = {
  readonly secret: string;
  readonly digits: number;
  readonly periodSeconds: number;
  readonly algorithm: string;
};

/** Reads the parameters an authenticator app would read from the QR code. */
export function parseOtpauthUri(uri: string): TotpParameters {
  const url = new URL(uri);
  if (url.protocol !== "otpauth:") {
    throw new Error(`not an otpauth URI: ${uri}`);
  }
  const secret = url.searchParams.get("secret");
  if (secret === null) {
    throw new Error(`no secret in ${uri}`);
  }
  return {
    secret,
    digits: Number(url.searchParams.get("digits") ?? "6"),
    periodSeconds: Number(url.searchParams.get("period") ?? "30"),
    algorithm: (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase(),
  };
}

export function totpCode(
  parameters: TotpParameters,
  atMs: number = Date.now(),
): string {
  const counter = Math.floor(atMs / 1000 / parameters.periodSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(
    parameters.algorithm,
    decodeBase32(parameters.secret),
  )
    .update(message)
    .digest();

  // Dynamic truncation, RFC 4226 section 5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** parameters.digits)
    .toString()
    .padStart(parameters.digits, "0");
}

/**
 * The seconds left in the current step.
 *
 * A code submitted in the last moment of a step can be verified in the next
 * one, which reads as a flaky test rather than as the race it is.
 */
export function secondsLeftInStep(
  parameters: TotpParameters,
  atMs: number = Date.now(),
): number {
  const seconds = Math.floor(atMs / 1000);
  return parameters.periodSeconds - (seconds % parameters.periodSeconds);
}

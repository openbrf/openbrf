import { randomBytes } from "node:crypto";

import { hashOpaqueToken } from "../auth/opaque-token";

/**
 * The tokens of the two links to an issue without an account, a reporter's
 * private link and a contractor's link to a work order, and the rules on their
 * form (ADR 0055).
 *
 * Both are the same kind of secret and differ only by their prefix, which
 * names the kind: one prefix per link, so a token of one kind has the form of
 * no token of the other and each controller refuses the other's before the
 * database is asked.
 */

/** The random part of every link token: 32 bytes from the OS's generator. */
export const LINK_TOKEN_BYTES = 32;

/**
 * A token's form, as a pattern's source: the prefix and the 43 characters
 * that 32 bytes make in unpadded base64url.
 */
export function linkTokenPattern(prefix: string): string {
  return `${prefix}[A-Za-z0-9_-]{43}`;
}

/** A new token of a kind: its prefix and 32 random bytes, in base64url. */
export function mintLinkToken(prefix: string): string {
  return `${prefix}${randomBytes(LINK_TOKEN_BYTES).toString("base64url")}`;
}

/**
 * The test of a token's form for one kind, anchored so nothing before or after
 * it passes. Read before any database access, so a malformed value costs no
 * query; it is then answered exactly as an unknown token is (ADR 0055, "No
 * enumeration").
 */
export function linkTokenForm(prefix: string): (value: string) => boolean {
  const form = new RegExp(`^${linkTokenPattern(prefix)}$`);
  return (value) => form.test(value);
}

/**
 * The digest a token is stored and looked up under: SHA-256, as every opaque
 * token in the application is (`hashOpaqueToken`, which says why no salt or
 * slow hash is wanted for a 256-bit random value).
 */
export function linkTokenDigest(token: string): string {
  return hashOpaqueToken(token);
}

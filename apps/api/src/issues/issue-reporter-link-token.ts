import {
  LINK_TOKEN_BYTES,
  linkTokenDigest,
  linkTokenForm,
  linkTokenPattern,
  mintLinkToken,
} from "./link-token";

/**
 * The token of a reporter's private link, and the rules on its form (ADR 0055).
 */

/**
 * What every reporter's link token starts with.
 *
 * For secret scanners and for a person reading where a link was pasted, as a
 * device token's prefix is (`device-token.ts`). Nothing grants on it: a token
 * opens what its digest is stored against, and the prefix only lets a request
 * that cannot be one be refused before the database is asked.
 */
export const REPORTER_LINK_TOKEN_PREFIX = "obrf_rl_";

/** The random part: 32 bytes from the operating system's generator. */
export const REPORTER_LINK_TOKEN_BYTES = LINK_TOKEN_BYTES;

/**
 * The whole token's form: the prefix and the 43 characters that 32 bytes make
 * in unpadded base64url, as a pattern's source.
 *
 * The link's routes are matched on it (`SiteIssueLinkController`), so a path
 * segment that cannot be a token is left to the website's own routes: the
 * forms of a page at /arende post to /arende/kontakt, which must reach the
 * page's form and not the link.
 */
export const REPORTER_LINK_TOKEN_PATTERN = linkTokenPattern(
  REPORTER_LINK_TOKEN_PREFIX,
);

/** A new token: the prefix and 32 random bytes, in base64url. */
export function mintReporterLinkToken(): string {
  return mintLinkToken(REPORTER_LINK_TOKEN_PREFIX);
}

/**
 * Whether a value from the path has the form of a reporter's link token.
 *
 * Read before any database access, so a malformed value costs no query; it is
 * then answered exactly as an unknown token is (ADR 0055, "No enumeration").
 */
export const hasReporterLinkTokenForm = linkTokenForm(
  REPORTER_LINK_TOKEN_PREFIX,
);

/**
 * The digest a token is stored and looked up under: SHA-256, as every opaque
 * token in the application is (`hashOpaqueToken`, which says why no salt or
 * slow hash is wanted for a 256-bit random value).
 */
export function reporterLinkDigest(token: string): string {
  return linkTokenDigest(token);
}

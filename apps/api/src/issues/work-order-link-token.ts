import {
  linkTokenDigest,
  linkTokenForm,
  linkTokenPattern,
  mintLinkToken,
} from "./link-token";

/**
 * The token of a contractor's link to a work order, and the rules on its form
 * (ADR 0055). The same kind of secret as a reporter's private link, behind a
 * prefix of its own, so neither kind has the other's form.
 */

/**
 * What every contractor's link token starts with. For secret scanners and for
 * a person reading where a link was pasted; nothing grants on it.
 */
export const WORK_ORDER_LINK_TOKEN_PREFIX = "obrf_wo_";

/** The token's form, as a pattern's source, which the routes match on. */
export const WORK_ORDER_LINK_TOKEN_PATTERN = linkTokenPattern(
  WORK_ORDER_LINK_TOKEN_PREFIX,
);

/** A new token: the prefix and 32 random bytes, in base64url. */
export function mintWorkOrderLinkToken(): string {
  return mintLinkToken(WORK_ORDER_LINK_TOKEN_PREFIX);
}

/**
 * Whether a value from the path has the form of a contractor's link token,
 * read before any database access.
 */
export const hasWorkOrderLinkTokenForm = linkTokenForm(
  WORK_ORDER_LINK_TOKEN_PREFIX,
);

/** The digest a token is stored and looked up under. */
export function workOrderLinkDigest(token: string): string {
  return linkTokenDigest(token);
}

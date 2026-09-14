import type { ProtectedResource } from "./protected-resource";

/**
 * The WWW-Authenticate headers the resource route answers with.
 *
 * A client that is refused has to be able to find out where to get a token
 * from, and RFC 9728 says how: the challenge carries a pointer to the
 * resource's own metadata document. Without it a client has an address, a 401
 * and nothing to do about either.
 *
 * The pointer names the sub-path form, because that is the route the connector
 * actually serves and the one a client should remember. The bare path answers
 * with the same document, so a client that only has the origin is not stuck.
 */

export function resourceMetadataUrl(
  resource: ProtectedResource,
  appUrl: string,
): string {
  return new URL(
    `/.well-known/oauth-protected-resource${resource.path}`,
    appUrl,
  ).toString();
}

/** The challenge on a request that presented no usable token. */
export function unauthorizedChallenge(metadataUrl: string): string {
  return `Bearer resource_metadata="${metadataUrl}"`;
}

/**
 * The challenge on a token that is valid but does not carry enough.
 *
 * Every scope the route could need is named at once rather than one at a time:
 * a client told only the next missing scope would have to be refused again for
 * each of the others, and each refusal is a round trip the person watches.
 */
export function insufficientScopeChallenge(
  metadataUrl: string,
  scopes: readonly string[],
  description: string,
): string {
  return [
    `Bearer error="insufficient_scope"`,
    `scope="${scopes.join(" ")}"`,
    `resource_metadata="${metadataUrl}"`,
    `error_description="${description.replaceAll('"', "'")}"`,
  ].join(", ");
}

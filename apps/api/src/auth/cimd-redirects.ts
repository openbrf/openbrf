import { isAcceptableRedirectUri } from "@openbrf/shared";

import {
  guardedMetadataFetch,
  MetadataFetchError,
  type MetadataResourceFetch,
} from "./cimd-fetch";

/**
 * Holds a client's metadata document to the redirect rule the consent screen
 * applies, before the discovery plugin registers the client.
 *
 * The plugin and the OAuth provider each check a document's `redirect_uris`
 * by rules of their own, and the consent screen checks the address it is about
 * to send the code to by the shared one. Those agree today, but only because
 * the libraries happen to match it: an address one of them takes and the
 * screen refuses would leave a member who has already said yes on a screen
 * that cannot finish. The plugin offers no hook that can refuse a document, so
 * the rule is applied where the document passes through this application, on
 * its way back from the transport.
 *
 * A document the plugin would refuse anyway - not JSON, not a 200, no list -
 * is handed on untouched for it to refuse in its own words. So is any other
 * resource this transport carries, a key set among them, which names no
 * redirect address.
 */
export function refusingUnacceptableRedirects(
  transport: MetadataResourceFetch,
): MetadataResourceFetch {
  return async (input, init) => {
    const response = await transport(input, init);
    if (response.status !== 200) {
      return response;
    }
    let document: unknown;
    try {
      // The transport has already read the body into memory within its bound,
      // so the copy costs no second transfer.
      document = JSON.parse(await response.clone().text());
    } catch {
      return response;
    }
    if (namesUnacceptableRedirect(document)) {
      throw new MetadataFetchError("redirect-uri-refused");
    }
    return response;
  };
}

function namesUnacceptableRedirect(document: unknown): boolean {
  if (typeof document !== "object" || document === null) {
    return false;
  }
  const uris = (document as { redirect_uris?: unknown }).redirect_uris;
  return (
    Array.isArray(uris) &&
    uris.some((uri) => typeof uri !== "string" || !isAcceptableRedirectUri(uri))
  );
}

/** The transport the auth options hand to the discovery plugin. */
export const cimdMetadataFetch: MetadataResourceFetch =
  refusingUnacceptableRedirects(guardedMetadataFetch);

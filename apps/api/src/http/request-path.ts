/**
 * A request's path as the router reads it.
 *
 * The router matches a path after decoding its percent-escapes, so the raw URL
 * is not what decides which handler runs: `/arende` spelled with an escaped
 * letter reaches the same handler as the plain spelling. A check that decides
 * something for a path compares this, and the route the router matched, never
 * the raw text alone.
 */

/** The path alone, with any query string dropped. */
export function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/**
 * The path with its percent-escapes decoded.
 *
 * Decodes more than the router does (an escaped slash too), which only widens
 * a match on a path prefix. A malformed escape is refused by the router before
 * any handler runs, so the raw path is returned for it.
 */
export function decodedPathOf(url: string): string {
  const path = pathOf(url);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

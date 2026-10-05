/**
 * The host of an address, for an audit entry or a screen.
 *
 * A host rather than the whole URL: what a board member needs to recognise is
 * which app this is, and a full URL with its path and query is both longer and
 * less recognisable. Null rather than a placeholder when it cannot be parsed,
 * so that a screen shows nothing rather than something untrue.
 */
export function hostOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * The host a connected app is reached at.
 *
 * A client that registered itself by the address of its own metadata document
 * (client ID metadata documents) has that address as its client id, which is
 * the most truthful host to name. Its `clientDiscoveryId` says only how it was
 * discovered - the discovery plugin's id, not a URL - so it names no host. A
 * client an administrator registered has no such id and is named by the
 * address it declared.
 *
 * One definition because the connected-app screens, the bearer's audit
 * entries, the record of processing and the access report all have to call
 * the same client the same thing.
 */
export function connectedAppHost(client: {
  clientId: string;
  clientDiscoveryId: string | null;
  uri: string | null;
}): string | null {
  return client.clientDiscoveryId !== null
    ? hostOf(client.clientId)
    : hostOf(client.uri);
}

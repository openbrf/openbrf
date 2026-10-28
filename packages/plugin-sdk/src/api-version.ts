/**
 * The plugin API version.
 *
 * A single integer rather than a semver range, because the gate it guards is
 * binary: a plugin either speaks the contract this host implements or it does
 * not get loaded. A range would invite a plugin to claim ">=1" and then fail
 * at the first call to a method version 2 removed, which is exactly the class
 * of breakage the gate exists to prevent.
 *
 * Additive changes - a new optional manifest field, a new SDK method - keep
 * the number. Anything a plugin built against the old contract could notice
 * raises it, and the host may then support more than one version at a time by
 * listing them in SUPPORTED_PLUGIN_API_VERSIONS.
 *
 * One exception (ADR 0020, as amended by ADR 0051): a security fix that does
 * nothing but refuse a use of the host by which a plugin acts for, or reads
 * about, a person beyond what the contract grants it keeps the number, when
 * raising it would refuse to load every plugin built against it, those that
 * never make that use included. Its ADR calls it a change to the plugin
 * contract and names the plugins that break, and the SDK takes a minor
 * release. Holding a request to the work that serves it is one.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * Every version this contract can still load. Kept as a list so a host can
 * carry an old version through a deprecation window without a plugin having
 * to be republished on the day the new one lands.
 */
export const SUPPORTED_PLUGIN_API_VERSIONS: readonly number[] = [
  PLUGIN_API_VERSION,
];

export function isSupportedApiVersion(apiVersion: number): boolean {
  return SUPPORTED_PLUGIN_API_VERSIONS.includes(apiVersion);
}

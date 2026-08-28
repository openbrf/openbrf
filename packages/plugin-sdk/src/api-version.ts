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

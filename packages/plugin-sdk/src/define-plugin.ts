import type { PluginServerFactory } from "./host.ts";

/**
 * Declares a plugin's server entry point.
 *
 * Deliberately an identity function. ADR 0003 requires a plugin to ship a
 * prebuilt CJS bundle whose only externals are host packages, so anything
 * this helper did at runtime would either have to be bundled into every
 * plugin or would make the SDK a runtime dependency the host has to resolve
 * for it. Being identity means a bundler inlines it to nothing and the value
 * the helper adds - the type of the factory, checked at the author's build
 * time - costs the running instance nothing.
 */
export function definePlugin(
  factory: PluginServerFactory,
): PluginServerFactory {
  return factory;
}

import { type DynamicModule, Module } from "@nestjs/common";
import type { PluginHost, PluginModuleFactory } from "@openbrf/plugin-sdk";
import { rulesContribution, SOURCE_TARGET } from "./rules.ts";

/**
 * The addon's server entry point.
 *
 * An addon is a plugin like any other (ADR 0030): the host calls this factory
 * with the addon's own host object, which carries the permissions the board
 * consented to for this addon and none of digital signage's. All it does is
 * contribute to the `source` point. It has no routes, no view and keeps
 * nothing.
 */
export const createPlugin: PluginModuleFactory = (
  host: PluginHost,
): DynamicModule => {
  // An instance without extension points never offers an addon (the plugin
  // contract, "Feature detection"), so this contributes nothing there.
  if (host.extensions === undefined) {
    host.logger.warn(
      "This instance has no extension points, so the addon contributes nothing.",
    );
  } else {
    host.extensions.contribute(SOURCE_TARGET, rulesContribution(host));
  }

  class SignageRulesModule {}
  Module({})(SignageRulesModule);
  return { module: SignageRulesModule };
};

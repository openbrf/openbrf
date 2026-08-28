/**
 * @openbrf/plugin-sdk - the public plugin contract for Open BRF.
 *
 * A plugin depends on this package for types and for the manifest schema it
 * validates itself against in its own CI. At runtime the host injects
 * everything a plugin uses (see PluginHost), so nothing exported here needs to
 * be resolvable from inside an installed plugin directory - which is what lets
 * a plugin ship as a self-contained bundle (ADR 0003).
 */

export {
  isSupportedApiVersion,
  PLUGIN_API_VERSION,
  SUPPORTED_PLUGIN_API_VERSIONS,
} from "./api-version.ts";
export { definePlugin } from "./define-plugin.ts";
export {
  PLUGIN_FINDING_REASONS,
  type PluginFindingDetail,
  type PluginFindingReason,
} from "./findings.ts";
export {
  type PluginAddressBook,
  type PluginApartment,
  type PluginHost,
  PluginHostUnavailableError,
  type PluginJobs,
  type PluginLogger,
  type PluginMail,
  type PluginMailMessage,
  type PluginOccupancySummary,
  PluginPermissionError,
  type PluginResident,
  type PluginSettings,
} from "./host.ts";
export type { PluginModuleFactory } from "./module.ts";
export {
  assertPluginPackage,
  CURRENT_PLUGIN_API_VERSION,
  type ManifestParseResult,
  type PluginEntry,
  pluginEntrySchema,
  pluginIdSchema,
  type PluginManifest,
  pluginManifestSchema,
  type PluginPackage,
  pluginPackageSchema,
  parsePluginPackage,
} from "./manifest.ts";
export {
  isPluginPermission,
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
  type PluginPermission,
  type PluginPersonalDataCategory,
} from "./permissions.ts";
export {
  defaultSettings,
  type PluginSettingsField,
  pluginSettingsFieldSchema,
  type PluginSettingsSchema,
  pluginSettingsSchema,
  type PluginSettingsValues,
  settingsValidator,
} from "./settings-schema.ts";

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
  ACTION_CHANNELS,
  ACTION_EFFECTS,
  ACTION_NAME_PATTERN,
  ACTION_PERSONAL_DATA,
  ACTION_SURFACES,
  type ActionChannel,
  type ActionClient,
  type ActionContext,
  type ActionDefinition,
  type ActionEffect,
  type ActionErrorSpec,
  type ActionPersonalData,
  type ActionPrincipal,
  type ActionRequest,
  type ActionSummary,
  type ActionSurface,
  type PluginActionFilter,
  type PluginActionRegistration,
  type PluginActions,
} from "./actions.ts";
export {
  actionInputJsonSchema,
  actionOutputJsonSchema,
  isHostZodSchema,
} from "./action-schema.ts";
export {
  isSupportedApiVersion,
  PLUGIN_API_VERSION,
  SUPPORTED_PLUGIN_API_VERSIONS,
} from "./api-version.ts";
export {
  PLUGIN_BLOCK_ATTRIBUTES,
  PLUGIN_BLOCK_CATEGORIES,
  PLUGIN_BLOCK_ELEMENTS,
  PLUGIN_BLOCK_ICONS,
  PLUGIN_BLOCK_NAME_PATTERN,
  PLUGIN_BLOCK_RENDER_TIMEOUT_MS,
  type PluginBlockAbortSignal,
  type PluginBlockCategory,
  type PluginBlockContent,
  type PluginBlockDeclaration,
  type PluginBlockElement,
  type PluginBlockElementName,
  type PluginBlockIcon,
  type PluginBlockNode,
  type PluginBlockRegistration,
  type PluginBlockRenderContext,
  type PluginBlocks,
  pluginBlockSchema,
  pluginBlocksSchema,
  pluginBlockType,
} from "./blocks.ts";
export {
  type Catalog,
  type CatalogArtifact,
  catalogArtifactSchema,
  type CatalogEntry,
  catalogEntrySchema,
  catalogEntryV2Schema,
  CATALOG_INDEX_VERSION,
  type CatalogParseResult,
  type CatalogPluginEntry,
  catalogPluginEntrySchema,
  catalogPluginEntryV2Schema,
  catalogSchema,
  type CatalogThemeEntry,
  catalogThemeEntrySchema,
  type LocalizedText,
  parseCatalogIndex,
} from "./catalog.ts";
export { definePlugin } from "./define-plugin.ts";
export { formatSha512, IntegrityError, parseSha512 } from "./integrity.ts";
export {
  PLUGIN_FINDING_REASONS,
  type PluginFindingDetail,
  type PluginFindingReason,
} from "./findings.ts";
export {
  type PluginAddressBook,
  type PluginApartment,
  type PluginAudit,
  type PluginAuditEntry,
  PLUGIN_AUDIT_LIMITS,
  type PluginHost,
  PluginHostUnavailableError,
  type PluginJobs,
  type PluginLogger,
  type PluginMail,
  type PluginMailMessage,
  type PluginOccupancySummary,
  PluginPermissionError,
  type PluginResident,
  type PluginResidentFilter,
  type PluginSettings,
  type PluginSms,
  type PluginSmsMessage,
} from "./host.ts";
export type { PluginModuleFactory } from "./module.ts";
export {
  assertPluginPackage,
  composedActionName,
  CURRENT_PLUGIN_API_VERSION,
  type ManifestParseResult,
  missingProcessingProblem,
  readsAddressBook,
  undeclaredPersonalDataProblem,
  PLUGIN_DATA_SUBJECTS,
  PLUGIN_LEGAL_BASES,
  type PluginActionDeclaration,
  pluginActionSchema,
  pluginActionsSchema,
  type PluginEntry,
  pluginEntrySchema,
  pluginIdSchema,
  type PluginDataSubject,
  type PluginLegalBasis,
  type PluginManifest,
  pluginManifestSchema,
  type PluginPackage,
  pluginPackageSchema,
  type PluginProcessing,
  pluginProcessingSchema,
  type PluginView,
  pluginViewSchema,
  type PluginViewSection,
  PLUGIN_VIEW_SECTIONS,
  parsePluginPackage,
} from "./manifest.ts";
export {
  HOST_SHARED_PACKAGES,
  type PluginPackageContents,
  pluginPackageProblems,
} from "./package-check.ts";
export type {
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from "./standard-schema.ts";
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

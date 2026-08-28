import type {
  PluginPermission,
  PluginPersonalDataCategory,
  PluginSettingsSchema,
  PluginSettingsValues,
} from "@openbrf/plugin-sdk";

import { apiRequest, type ApiResult } from "../api/client";

/**
 * The plugin endpoints.
 *
 * The shapes mirror the API's responses. Only the settings schema is imported
 * from the SDK rather than restated: it is the one shape a plugin author also
 * writes against, so a second definition here would be a second contract that
 * could disagree with the one plugins are built to.
 */

export interface PluginSummary {
  id: string;
  packageName: string;
  version: string;
  enabled: boolean;
  /** PENDING, INSTALLED or FAILED. */
  status: string;
  lastError: string | null;
  /** Whether the plugin's code is running in the current server process. */
  loaded: boolean;
  permissions: string[];
  personalData: string[];
  installedAt: string;
  hasSettings: boolean;
  view: { module: string; titleKey: string } | null;
}

/** Why a plugin present on the data volume is not running. */
export interface PluginFinding {
  id: string | null;
  directory: string;
  reason: string;
  detail: string;
}

export interface PluginsOverview {
  pluginsEnabled: boolean;
  restartPending: boolean;
  plugins: PluginSummary[];
  findings: PluginFinding[];
}

export interface CatalogPlugin {
  id: string;
  packageName: string;
  version: string;
  name: { sv: string; en: string };
  description: { sv: string; en: string };
  homepage: string | null;
  deprecated: boolean;
  apiVersion: number;
  permissions: PluginPermission[];
  personalData: PluginPersonalDataCategory[];
  supported: boolean;
  installedVersion: string | null;
}

export interface CatalogListing {
  source: string;
  entries: CatalogPlugin[];
}

export interface PluginSettingsResponse {
  id: string;
  schema: PluginSettingsSchema | null;
  values: PluginSettingsValues;
}

export interface PluginViewDescriptor {
  id: string;
  titleKey: string;
  module: string;
  remoteEntry: string;
}

export function fetchPlugins(): Promise<ApiResult<PluginsOverview>> {
  return apiRequest("GET", "/api/plugins");
}

export function fetchCatalog(): Promise<ApiResult<CatalogListing>> {
  return apiRequest("GET", "/api/plugins/catalog");
}

export function fetchPluginViews(): Promise<
  ApiResult<{ views: PluginViewDescriptor[] }>
> {
  return apiRequest("GET", "/api/plugin-views");
}

/**
 * Installs a plugin.
 *
 * The permissions and personal data categories the consent screen showed are
 * sent back with the request. The API refuses the install when they no longer
 * match the catalog, so a board never installs on the strength of a screen
 * that has since become wrong.
 */
export function installPlugin(input: {
  id: string;
  permissions: readonly PluginPermission[];
  personalData: readonly PluginPersonalDataCategory[];
}): Promise<ApiResult<{ restarting: boolean }>> {
  return apiRequest("POST", "/api/plugins", input);
}

export function uninstallPlugin(
  id: string,
): Promise<ApiResult<{ restarting: boolean }>> {
  return apiRequest("DELETE", `/api/plugins/${encodeURIComponent(id)}`);
}

export function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<ApiResult<{ restarting: boolean }>> {
  return apiRequest("PUT", `/api/plugins/${encodeURIComponent(id)}/enabled`, {
    enabled,
  });
}

export function fetchPluginSettings(
  id: string,
): Promise<ApiResult<PluginSettingsResponse>> {
  return apiRequest("GET", `/api/plugins/${encodeURIComponent(id)}/settings`);
}

export function savePluginSettings(
  id: string,
  values: PluginSettingsValues,
): Promise<ApiResult<PluginSettingsResponse>> {
  return apiRequest("PUT", `/api/plugins/${encodeURIComponent(id)}/settings`, {
    values,
  });
}

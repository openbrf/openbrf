import type {
  PluginActionDeclaration,
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
  permissions: PluginPermission[];
  personalData: PluginPersonalDataCategory[];
  /**
   * The action declaration the board consented to, canonically.
   *
   * Each entry is `id:capability:effect:personalData:surfaces`, the last two
   * pipe-separated, exactly as the server compares an installed manifest
   * against it. Carried as the string rather than as parts because it is the
   * snapshot the consent is held in: splitting it on the server would make the
   * browser's idea of the declaration the one that could drift.
   */
  consentedActions: string[];
  /** The ids an administrator has armed, a subset of the above. */
  armedActions: string[];
  installedAt: string;
  hasSettings: boolean;
  view: { module: string; titleKey: string } | null;
}

/**
 * Why a plugin present on the data volume is not running.
 *
 * `reason` is a code, not a sentence, and `detail` holds the values the
 * sentence is completed with. `reason` is typed as a string rather than as the
 * contract's union for the same reason every other wire shape here is: the
 * browser applies what the API sent, it does not decide which codes exist. The
 * table that turns a code into a sentence is typed against the union instead,
 * so the exhaustiveness is checked where the sentences are.
 */
export interface PluginFinding {
  id: string | null;
  directory: string;
  reason: string;
  detail: Record<string, string | number | string[]>;
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
  /**
   * What the plugin proposes the platform be able to do, repeated in the
   * catalog so the consent screen can state it before anything is downloaded.
   */
  actions: PluginActionDeclaration[];
  /**
   * The route this plugin would serve connected-app sign-in on, or null for
   * one that serves none.
   *
   * The path under the plugin's own mount rather than the whole address: what
   * the full URL is composed of is the server's, and a second composition here
   * would be a second answer to what the address is.
   */
  oauthProtectedResource: string | null;
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
 * The whole declaration the consent screen showed is sent back with the
 * request. The API refuses the install when any of it no longer matches the
 * catalog, so a board never installs on the strength of a screen that has
 * since become wrong - and it compares all of it the moment one part is
 * echoed, which is why the actions travel with the other two rather than being
 * left out as a list nobody pressed a button about.
 *
 * The protected resource travels as null when the screen showed none, because
 * that is a statement about what the board read: an entry that has come to
 * declare one since is then refused rather than installed on a screen that
 * never mentioned the address connected apps sign in to.
 */
export function installPlugin(input: {
  id: string;
  permissions: readonly PluginPermission[];
  personalData: readonly PluginPersonalDataCategory[];
  actions: readonly PluginActionDeclaration[];
  oauthProtectedResource: string | null;
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

/**
 * Arms or disarms one of a plugin's declared actions.
 *
 * Arming is what offers the action to a connected app and to the AI package;
 * the consent the board gave at install is what makes it offerable at all.
 * Both halves are kept, so an action nobody has armed is declared and idle.
 */
export function setPluginActionArmed(
  id: string,
  actionId: string,
  armed: boolean,
): Promise<ApiResult<void>> {
  return apiRequest(
    "PUT",
    `/api/plugins/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`,
    { armed },
  );
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

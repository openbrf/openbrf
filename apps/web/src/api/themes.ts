import { apiRequest, type ApiResult } from "./client";

/**
 * The theme endpoints.
 *
 * These types mirror the API's wire shapes. Token values arrive as a plain
 * record rather than a typed set: the browser applies them, it does not reason
 * about which names exist, and a theme written against a later minor of the
 * contract would otherwise fail to type here for no benefit.
 */

export type ThemeTokenValues = Record<string, string>;

export interface ThemeFontSummary {
  family: string;
  license: string;
}

export interface ThemeSummary {
  id: string;
  name: string;
  description: string | null;
  /** Null for the built-in theme, which is versioned with the application. */
  version: string | null;
  builtIn: boolean;
  /** Composed on this instance rather than installed from a catalog. */
  composed: boolean;
  active: boolean;
  extendsThemeId: string | null;
  fonts: ThemeFontSummary[];
  viewVariants: Record<string, string>;
  installedAt: string | null;
}

/**
 * What a theme declares, which is what the composer edits.
 *
 * Only the values the theme states: everything else it inherits, and the
 * composer shows those as the placeholders it would write over.
 */
export interface ThemeDeclaration {
  id: string;
  displayName: string;
  description: string | null;
  extendsThemeId: string | null;
  version: string;
  composed: boolean;
  modes: { light: ThemeTokenValues; dark: ThemeTokenValues };
}

/** What the composer sends: an identity, a parent, and colour overrides. */
export interface ComposeThemeInput {
  id: string;
  displayName: string;
  description?: string;
  extends: string;
  modes: { light: ThemeTokenValues; dark: ThemeTokenValues };
}

export interface ThemeFontFace {
  family: string;
  weight: string;
  style: string;
  url: string;
  format: string | null;
}

/** Everything needed to render a theme in the browser. */
export interface ThemeRendering {
  id: string;
  name: string;
  builtIn: boolean;
  modes: { light: ThemeTokenValues; dark: ThemeTokenValues };
  fontFaces: ThemeFontFace[];
  viewVariants: Record<string, string>;
  logoUrl: string | null;
}

export interface CatalogTheme {
  id: string;
  name: string;
  description: string | null;
  version: string;
  contract: string | null;
  /** The version already installed, when this theme is installed. */
  installedVersion: string | null;
}

/** One reason the install lint refused a theme, or warned about it. */
export interface ThemeLintFinding {
  rule: string;
  severity: "error" | "warning";
  detail: Record<string, string | number | boolean>;
}

export interface ThemeInstallResult {
  theme: ThemeSummary;
  warnings: ThemeLintFinding[];
}

export function fetchActiveTheme(): Promise<ApiResult<ThemeRendering>> {
  return apiRequest("GET", "/api/themes/active");
}

export function fetchInstalledThemes(): Promise<ApiResult<ThemeSummary[]>> {
  return apiRequest("GET", "/api/themes/installed");
}

export function fetchThemeCatalog(): Promise<ApiResult<CatalogTheme[]>> {
  return apiRequest("GET", "/api/themes/catalog");
}

export function installTheme(
  id: string,
): Promise<ApiResult<ThemeInstallResult>> {
  return apiRequest("POST", "/api/themes/install", { id });
}

export function fetchThemePreview(
  id: string,
): Promise<ApiResult<ThemeRendering>> {
  return apiRequest(
    "GET",
    `/api/themes/installed/${encodeURIComponent(id)}/preview`,
  );
}

/**
 * Composes a theme on the instance, or saves an edit to one.
 *
 * The id decides which. The server runs the install lint either way, so a
 * refusal here carries the same findings a refused install does.
 */
export function composeTheme(
  input: ComposeThemeInput,
): Promise<ApiResult<ThemeInstallResult>> {
  return apiRequest("POST", "/api/themes/compose", input);
}

export function fetchThemeSource(
  id: string,
): Promise<ApiResult<ThemeDeclaration>> {
  return apiRequest(
    "GET",
    `/api/themes/installed/${encodeURIComponent(id)}/source`,
  );
}

/** Null returns to the built-in theme. */
export function activateTheme(
  id: string | null,
): Promise<ApiResult<ThemeSummary[]>> {
  return apiRequest("POST", "/api/themes/activate", { id });
}

export function uninstallTheme(id: string): Promise<ApiResult<ThemeSummary[]>> {
  return apiRequest(
    "DELETE",
    `/api/themes/installed/${encodeURIComponent(id)}`,
  );
}

/**
 * @openbrf/theme-tools - the theme package format, its lint and its inheritance.
 *
 * Used by the core at install time and by a theme repository's own CI, so a
 * theme author sees the same refusal we would give them, before they publish.
 */

export {
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  readThemeArchive,
  ThemeArchiveError,
  writeThemeArchive,
} from "./archive.ts";
export type { ThemeArchiveFiles } from "./archive.ts";

export { buildFontFaceStylesheet, cssString, themeFontFaces } from "./fonts.ts";
export type { ThemeFontFaceSource } from "./fonts.ts";

export {
  BUILT_IN_THEME,
  mergeChain,
  resolveChainTokens,
  resolveThemeChain,
  unknownTokenNames,
} from "./inherit.ts";
export type {
  ChainResult,
  ResolvedThemeModes,
  ThemeChainEntry,
  ThemeLookup,
} from "./inherit.ts";

export {
  AA_CONTRAST_RATIO,
  chainEntryFor,
  lintTheme,
  THEME_MANIFEST_FILE,
} from "./lint.ts";
export type {
  ThemeLintFinding,
  ThemeLintInput,
  ThemeLintResult,
  ThemeLintRule,
  ThemeLintSeverity,
} from "./lint.ts";

export {
  BUILT_IN_THEME_ID,
  isPackagePath,
  KNOWN_MANIFEST_FIELDS,
  parseThemeManifest,
  themeManifestSchema,
} from "./manifest.ts";
export type {
  ManifestParseResult,
  ThemeFontDeclaration,
  ThemeManifest,
} from "./manifest.ts";

export { readThemePackage } from "./package.ts";
export type { ReadThemePackageResult, ThemePackage } from "./package.ts";

export {
  compareVersions,
  isRange,
  isVersion,
  parseVersion,
  satisfiesRange,
} from "./semver-range.ts";
export type { SemanticVersion } from "./semver-range.ts";

export {
  resolveViewVariant,
  VIEW_VARIANT_SLOTS,
  viewVariantProblems,
  viewVariantSlot,
} from "./view-variants.ts";
export type {
  ViewVariantProblem,
  ViewVariantSelection,
  ViewVariantSlot,
  ViewVariantSlotName,
} from "./view-variants.ts";

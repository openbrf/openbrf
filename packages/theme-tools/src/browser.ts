/**
 * @openbrf/theme-tools in a browser - everything but the package reader.
 *
 * The web application applies a theme with the same manifest, inheritance,
 * fonts and view variants the core installs it with, so those have to load in
 * a browser. The archive reader and writer, and the package lint built on
 * them, unpack with node:zlib, which a browser does not have. A bundler that
 * resolves the `browser` condition loads this entry instead of index.ts, and
 * the browser's module graph never reaches node:zlib: under the Vite
 * development server a named import from it fails when the module is linked,
 * and takes every module that imports this package down with it.
 *
 * Nothing exported here may import a node: module, which browser.spec.ts
 * holds it to.
 */

export {
  buildFontFaceStylesheet,
  cssFontStyle,
  cssFontWeight,
  cssString,
  themeFontFaces,
} from "./fonts.ts";
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
  themeFontDeclarationSchema,
  themeManifestSchema,
} from "./manifest.ts";
export type {
  ManifestParseResult,
  ThemeFontDeclaration,
  ThemeManifest,
} from "./manifest.ts";

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

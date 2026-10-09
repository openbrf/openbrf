/**
 * @openbrf/theme-tools - the theme package format, its lint and its inheritance.
 *
 * Used by the core at install time and by a theme repository's own CI, so a
 * theme author sees the same refusal we would give them, before they publish.
 *
 * This is the entry Node loads. A browser gets browser.ts instead, which is
 * all of this except the archive and the package reader built on it.
 */

export * from "./browser.ts";

export {
  MAX_ARCHIVE_ENTRIES,
  MAX_DIRECTORY_RECORDS,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  readThemeArchive,
  ThemeArchiveError,
  writeThemeArchive,
} from "./archive.ts";
export type { ThemeArchiveFiles } from "./archive.ts";

export {
  lintThemeAgainst,
  lintThemePackage,
  readThemePackage,
} from "./package.ts";
export type {
  LintThemePackageResult,
  ReadThemePackageResult,
  ThemePackage,
} from "./package.ts";

import { readThemeArchive, type ThemeArchiveFiles } from "./archive.ts";
import {
  BUILT_IN_THEME,
  resolveThemeChain,
  type ThemeChainEntry,
} from "./inherit.ts";
import {
  chainEntryFor,
  lintTheme,
  THEME_MANIFEST_FILE,
  type ThemeLintResult,
} from "./lint.ts";
import { parseThemeManifest, type ThemeManifest } from "./manifest.ts";

/**
 * A theme package as read from a downloaded tarball: the manifest it declares
 * and the files it carries.
 *
 * Reading is separate from linting on purpose. Reading answers "is this a theme
 * package at all", which is a property of the archive; linting answers "may it
 * be installed here", which depends on the core's contract version and on the
 * themes already installed. The installer does the first, then resolves the
 * inheritance chain, then does the second.
 */
export interface ThemePackage {
  manifest: ThemeManifest;
  files: ThemeArchiveFiles;
  /** The manifest as parsed from JSON, for the unknown-field warning. */
  raw: Readonly<Record<string, unknown>>;
}

export type ReadThemePackageResult =
  | { ok: true; package: ThemePackage }
  | {
      ok: false;
      reason: "archive" | "manifest-missing" | "manifest-invalid";
      issues: readonly string[];
    };

export function readThemePackage(archive: Uint8Array): ReadThemePackageResult {
  let files: ThemeArchiveFiles;
  try {
    files = readThemeArchive(archive);
  } catch (cause) {
    return { ok: false, reason: "archive", issues: [(cause as Error).message] };
  }

  const manifestFile = files.get(THEME_MANIFEST_FILE);
  if (manifestFile === undefined) {
    return {
      ok: false,
      reason: "manifest-missing",
      issues: [`The package has no ${THEME_MANIFEST_FILE} at its root.`],
    };
  }

  const parsed = parseThemeManifest(
    new TextDecoder("utf8").decode(manifestFile),
  );
  if (!parsed.ok) {
    return { ok: false, reason: "manifest-invalid", issues: parsed.issues };
  }

  return {
    ok: true,
    package: { manifest: parsed.manifest, files, raw: parsed.raw },
  };
}

/**
 * Lints a theme package against a set of installed themes.
 *
 * The chain matters: a theme extending another installed theme has to be
 * measured with its parent's values in place, or a child that only changes
 * the accent would look like a theme with no colours at all. So the chain is
 * resolved over the built-in theme, the installed themes and the candidate,
 * with the candidate replacing an installed theme of the same id - which is
 * what installing it would do.
 *
 * One implementation for the instance, which passes what it has installed, and
 * for a theme's own CI and the catalog's check, which pass the themes it may
 * extend. They see the same refusal.
 */
export function lintThemeAgainst(
  pkg: ThemePackage,
  installed: readonly ThemeChainEntry[],
): ThemeLintResult {
  const candidate = chainEntryFor(pkg.manifest);
  const byId = new Map<string, ThemeChainEntry>([
    [BUILT_IN_THEME.id, BUILT_IN_THEME],
    ...installed
      .filter((entry) => entry.id !== candidate.id)
      .map((entry) => [entry.id, entry] as const),
    [candidate.id, candidate],
  ]);

  return lintTheme({
    manifest: pkg.manifest,
    files: [...pkg.files.keys()],
    chain: resolveThemeChain(pkg.manifest.name, (id) => byId.get(id)),
    rawManifest: pkg.raw,
  });
}

export type LintThemePackageResult =
  | Extract<ReadThemePackageResult, { ok: false }>
  | { ok: true; manifest: ThemeManifest; lint: ThemeLintResult };

/**
 * Reads a packed theme and lints it, as the instance does at install.
 *
 * A package that cannot be read is answered with the reader's own failure;
 * one that can is answered with its manifest and the lint, whose `ok` says
 * whether an instance would admit it. Warnings do not block.
 */
export function lintThemePackage(
  archive: Uint8Array,
  installed: readonly ThemeChainEntry[] = [],
): LintThemePackageResult {
  const read = readThemePackage(archive);
  if (!read.ok) {
    return read;
  }
  return {
    ok: true,
    manifest: read.package.manifest,
    lint: lintThemeAgainst(read.package, installed),
  };
}

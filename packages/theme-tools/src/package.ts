import { readThemeArchive, type ThemeArchiveFiles } from "./archive.ts";
import { THEME_MANIFEST_FILE } from "./lint.ts";
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

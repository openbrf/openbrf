import {
  AA_CONTRAST_RATIO,
  checkContrast,
  type PartialTokenSet,
  TOKEN_CONTRACT_VERSION,
  type TokenSet,
  tokenValueProblem,
} from "@openbrf/tokens";

import {
  type ChainResult,
  resolveChainTokens,
  type ThemeChainEntry,
  unknownTokenNames,
} from "./inherit.ts";
import {
  BUILT_IN_THEME_ID,
  KNOWN_MANIFEST_FIELDS,
  type ThemeManifest,
} from "./manifest.ts";
import { satisfiesRange } from "./semver-range.ts";
import { viewVariantProblems } from "./view-variants.ts";

/**
 * The install-time theme lint.
 *
 * This is a gate, not advice. A theme is installed by a board member from a
 * catalog, and two of the rules below exist because getting them wrong has
 * consequences the board cannot see from the install screen:
 *
 *   Contrast. The member register and the apartment register are documents an
 *   association is legally required to be able to produce and read. A theme
 *   that renders them at 3:1 is refused outright, and the pairs that touch the
 *   register surface are marked statutory so the refusal can say why.
 *
 *   Fonts. A theme may not reference a font over the network. Loading a font
 *   from a third party discloses every visitor's IP address to that third
 *   party, which is a GDPR problem in the EU, so fonts are bundled in the
 *   package and each one declares its licence.
 *
 * The rest enforce that a theme really is data: no scripts, no stylesheets, no
 * markup, only a manifest and the assets it names.
 *
 * Findings travel as a rule code plus detail, never as prose. The interface is
 * Swedish by default and this package is English, so the sentence a board reads
 * is a translation of the code.
 */

export type ThemeLintRule =
  /** The default theme's id is reserved: it is built in, never installed. */
  | "reserved-id"
  | "self-extends"
  | "contract-incompatible"
  | "missing-parent"
  | "inheritance-cycle"
  /** A top-level manifest field this core does not know. Ignored. */
  | "unknown-manifest-field"
  /** A token name this contract version does not define. Ignored. */
  | "unknown-token"
  /** A token with no value and no fallback to derive one from. */
  | "missing-token"
  | "unsafe-token-value"
  | "contrast"
  /** A file that could execute, or otherwise is not data. */
  | "executable-content"
  | "unexpected-file"
  | "font-remote-source"
  | "font-file-missing"
  | "font-file-undeclared"
  | "font-format"
  /** A bundled font whose declaration states no licence. */
  | "font-license-missing"
  | "license-file-missing"
  | "logo-missing"
  | "unknown-view-variant";

export type ThemeLintSeverity = "error" | "warning";

export interface ThemeLintFinding {
  rule: ThemeLintRule;
  severity: ThemeLintSeverity;
  /** Interpolation values for the translated sentence. Never prose. */
  detail: Readonly<Record<string, string | number | boolean>>;
}

export interface ThemeLintInput {
  manifest: ThemeManifest;
  /** Paths of every file in the package, the manifest included. */
  files: Iterable<string>;
  /**
   * The theme's ancestry, root first, ending with the theme itself. Produced by
   * resolveThemeChain against the installed set plus the built-in theme.
   */
  chain: ChainResult;
  /** The core's contract version. Overridable so a test can pin it. */
  contractVersion?: string;
  /** The manifest as parsed from JSON, for the unknown-field warning. */
  rawManifest?: Readonly<Record<string, unknown>>;
}

export interface ThemeLintResult {
  /** True when nothing failed. Warnings do not block an install. */
  ok: boolean;
  findings: readonly ThemeLintFinding[];
  /** The resolved token sets, present only when resolution succeeded. */
  resolved: { light: TokenSet; dark: TokenSet } | null;
}

/**
 * File extensions a theme package may contain.
 *
 * SVG is deliberately absent. An SVG is a document that can carry script and
 * external references, and a theme's logo is served from the instance's own
 * origin - so a themed logo would be a way to run script there. Raster formats
 * carry no such payload, and a logo has no need to.
 */
const ALLOWED_EXTENSIONS = new Set([
  "json",
  "woff2",
  "woff",
  "ttf",
  "otf",
  "png",
  "webp",
  "txt",
  "md",
]);

const FONT_EXTENSIONS = new Set(["woff2", "woff", "ttf", "otf"]);

/** Extensions that would make a theme executable rather than data. */
const EXECUTABLE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "wasm",
  "html",
  "htm",
  "xhtml",
  "svg",
  "css",
  "map",
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** True for anything that reaches outside the package to fetch the file. */
function isRemoteReference(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    /\bdata:/i.test(trimmed)
  );
}

export const THEME_MANIFEST_FILE = "theme.json";

export function lintTheme(input: ThemeLintInput): ThemeLintResult {
  const findings: ThemeLintFinding[] = [];
  const manifest = input.manifest;
  const files = new Set(input.files);
  const contractVersion = input.contractVersion ?? TOKEN_CONTRACT_VERSION;

  const fail = (
    rule: ThemeLintRule,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): void => {
    findings.push({ rule, severity: "error", detail });
  };
  const warn = (
    rule: ThemeLintRule,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): void => {
    findings.push({ rule, severity: "warning", detail });
  };

  // --- Identity ------------------------------------------------------------
  if (manifest.name === BUILT_IN_THEME_ID) {
    fail("reserved-id", { themeId: manifest.name });
  }
  if (manifest.extends === manifest.name) {
    fail("self-extends", { themeId: manifest.name });
  }
  if (!satisfiesRange(contractVersion, manifest.contract)) {
    fail("contract-incompatible", {
      range: manifest.contract,
      contractVersion,
    });
  }

  // --- Forward compatibility ----------------------------------------------
  if (input.rawManifest !== undefined) {
    const known = new Set(KNOWN_MANIFEST_FIELDS);
    for (const field of Object.keys(input.rawManifest)) {
      if (!known.has(field)) {
        warn("unknown-manifest-field", { field });
      }
    }
  }

  for (const [mode, values] of Object.entries(manifest.modes)) {
    for (const name of unknownTokenNames(values)) {
      warn("unknown-token", { mode, token: name });
    }
  }

  // --- The package holds data, and only data -------------------------------
  for (const path of files) {
    const extension = extensionOf(path);
    if (EXECUTABLE_EXTENSIONS.has(extension)) {
      fail("executable-content", { file: path });
      continue;
    }
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      fail("unexpected-file", { file: path });
    }
  }

  // --- Fonts: bundled, licensed, never fetched from a third party ----------
  const declaredFontFiles = new Set<string>();
  for (const font of manifest.fonts) {
    if (isRemoteReference(font.family)) {
      fail("font-remote-source", { family: font.family, source: font.family });
    }
    // The schema requires the field; only this reads it as a statement. A
    // bundled font is a redistribution, and one whose licence is a run of
    // spaces is a redistribution nobody can check.
    if (font.license.trim().length === 0) {
      fail("font-license-missing", { family: font.family });
    }
    if (font.licenseFile !== undefined && !files.has(font.licenseFile)) {
      fail("license-file-missing", {
        family: font.family,
        file: font.licenseFile,
      });
    }
    for (const file of font.files) {
      if (isRemoteReference(file.path)) {
        fail("font-remote-source", { family: font.family, source: file.path });
        continue;
      }
      declaredFontFiles.add(file.path);
      if (!files.has(file.path)) {
        fail("font-file-missing", { family: font.family, file: file.path });
        continue;
      }
      if (!FONT_EXTENSIONS.has(extensionOf(file.path))) {
        fail("font-format", { family: font.family, file: file.path });
      }
    }
  }

  for (const path of files) {
    if (
      FONT_EXTENSIONS.has(extensionOf(path)) &&
      !declaredFontFiles.has(path)
    ) {
      // A font file nobody declared is a redistribution with no stated licence
      // and no way to load it. Both halves of that are defects.
      fail("font-file-undeclared", { file: path });
    }
  }

  if (manifest.logo !== undefined && !files.has(manifest.logo)) {
    fail("logo-missing", { file: manifest.logo });
  }

  // --- View variants -------------------------------------------------------
  for (const problem of viewVariantProblems(manifest.viewVariants)) {
    fail("unknown-view-variant", {
      slot: problem.slot,
      variant: problem.variant,
      reason: problem.reason,
    });
  }

  // --- Token values, resolution and contrast -------------------------------
  for (const [mode, values] of Object.entries(manifest.modes)) {
    for (const [token, value] of Object.entries(values)) {
      const problem = tokenValueProblem(value);
      if (problem !== null) {
        fail("unsafe-token-value", { mode, token, problem });
      }
    }
  }

  if (!input.chain.ok) {
    fail(
      input.chain.reason === "cycle" ? "inheritance-cycle" : "missing-parent",
      { themeId: input.chain.themeId },
    );
    return { ok: false, findings, resolved: null };
  }

  const resolved = resolveChainTokens(input.chain.chain);
  for (const [mode, result] of Object.entries(resolved)) {
    for (const token of result.missing) {
      fail("missing-token", { mode, token });
    }
  }

  const complete =
    resolved.light.missing.length === 0 && resolved.dark.missing.length === 0;

  if (complete) {
    for (const [mode, result] of Object.entries(resolved)) {
      for (const finding of checkContrast(result.tokens)) {
        fail("contrast", {
          mode,
          foreground: finding.foreground,
          background: finding.background,
          ratio: finding.ratio ?? -1,
          required: finding.required,
          statutory: finding.statutory,
        });
      }
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    findings,
    resolved: complete
      ? { light: resolved.light.tokens, dark: resolved.dark.tokens }
      : null,
  };
}

/** Re-exported so a theme repository's CI can state the bar it is held to. */
export { AA_CONTRAST_RATIO };

/** The chain entry an installed theme contributes to inheritance. */
export function chainEntryFor(manifest: ThemeManifest): ThemeChainEntry {
  return {
    id: manifest.name,
    extends: manifest.extends ?? null,
    modes: {
      light: manifest.modes.light as PartialTokenSet,
      dark: manifest.modes.dark as PartialTokenSet,
    },
  };
}

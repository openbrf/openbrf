import { z } from "zod";

import { isRange, isVersion } from "./semver-range.ts";

/**
 * The theme package format: `theme.json` at the root of the package.
 *
 * A theme is pure data. It declares an identity, a contract range, the theme it
 * inherits from, the token values it changes in each mode, the font files it
 * bundles together with their licences, a logo, and which of the core's own
 * view variants it wants. There is no field here that carries code, and none
 * will be added: a theme that needs code is a UI plugin and lives under the
 * plugin rules instead.
 *
 * Unknown top-level fields are kept out of the parsed value but do not fail
 * parsing. That is what lets a theme authored against a later contract install
 * on an earlier core - the reason `license`, `requires` and `recommends` are
 * accepted below and then ignored. The linter reports unknown fields as a
 * warning so a misspelled `extend` is still visible to the author.
 */

const THEME_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Reserved: the default theme is built into the core, never installed. */
export const BUILT_IN_THEME_ID = "porttavlan";

/**
 * Whether a path inside the package is one this format allows.
 *
 * Every rule here exists to stop a path escaping the theme's own directory once
 * it is written to disk or served back over HTTP: no absolute path, no drive
 * letter, no parent segment, no backslash, no empty segment, and no leading dot
 * on a segment. Anything else would have to be re-checked at every use.
 */
export function isPackagePath(value: string): boolean {
  if (value.length === 0 || value.length > 200) {
    return false;
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => /^[a-z0-9][a-z0-9._-]*$/i.test(segment));
}

const packagePath = z
  .string()
  .refine(isPackagePath, "must be a relative path inside the theme package");

const themeId = z
  .string()
  .min(2)
  .max(64)
  .regex(THEME_ID_PATTERN, "must be lowercase words joined by hyphens");

const releaseVersion = z
  .string()
  .refine(isVersion, "must be a release version, e.g. 1.2.0");

const contractRange = z
  .string()
  .min(1)
  .max(64)
  .refine(isRange, "must be a version range, e.g. ^1.0.0");

/**
 * Token values as written by the theme author.
 *
 * Names are not constrained to the contract here. A theme written against a
 * later minor may legitimately carry a token this core has never heard of, so
 * the linter reports unknown names as a warning and resolution ignores them,
 * rather than parsing failing on a value that is simply newer than us.
 */
const tokenMap = z.record(
  z.string().min(1).max(64),
  z.string().min(1).max(200),
);

const fontFile = z.object({
  path: packagePath,
  /** CSS font-weight: a single weight or a variable-font range. */
  weight: z
    .string()
    .regex(/^\d{3}(?: \d{3})?$/)
    .default("400"),
  style: z.enum(["normal", "italic"]).default("normal"),
});

const fontDeclaration = z.object({
  family: z.string().min(1).max(80),
  /**
   * The licence the font is distributed under, as an SPDX identifier or a
   * name. Required: a bundled font with no stated licence is a redistribution
   * nobody can check, and the install lint refuses it.
   */
  license: z.string().min(1).max(120),
  /** The licence text shipped in the package, where the font requires it. */
  licenseFile: packagePath.optional(),
  files: z.array(fontFile).min(1).max(12),
});

export const themeManifestSchema = z.object({
  name: themeId,
  displayName: z.string().min(1).max(120),
  version: releaseVersion,
  /** Contract versions this theme was written against. */
  contract: contractRange,
  /** The theme this one inherits from. Null or absent means a root theme. */
  extends: themeId.nullish(),
  description: z.string().max(400).optional(),

  modes: z
    .object({
      light: tokenMap.default({}),
      dark: tokenMap.default({}),
    })
    .default({ light: {}, dark: {} }),

  fonts: z.array(fontDeclaration).max(8).default([]),
  logo: packagePath.optional(),

  /** Core-maintained view variants, keyed by the slot they fill. */
  viewVariants: z
    .record(z.string().min(1).max(64), z.string().min(1).max(64))
    .default({}),

  /*
   * Accepted and inert in phase 1.
   *
   * The fuller contract gives these meaning - a licence to validate, theme
   * dependencies to resolve - and none of that behaviour exists yet. Accepting
   * the fields anyway is what lets a theme authored against that contract
   * install here unchanged, which is the point: the alternative is a format
   * that has to be forked the day dependency resolution ships.
   *
   * `requires` and `recommends` are typed as unknown rather than guessed at. A
   * shape invented now would be the one shape the real contract has to avoid.
   */
  license: z.string().max(120).optional(),
  requires: z.unknown().optional(),
  recommends: z.unknown().optional(),
});

export type ThemeManifest = z.infer<typeof themeManifestSchema>;
export type ThemeFontDeclaration = ThemeManifest["fonts"][number];

/** Top-level fields this core knows about, for the unknown-field warning. */
export const KNOWN_MANIFEST_FIELDS: readonly string[] = [
  "name",
  "displayName",
  "version",
  "contract",
  "extends",
  "description",
  "modes",
  "fonts",
  "logo",
  "viewVariants",
  "license",
  "requires",
  "recommends",
];

export type ManifestParseResult =
  | { ok: true; manifest: ThemeManifest; raw: Record<string, unknown> }
  | { ok: false; issues: readonly string[] };

/**
 * Parses `theme.json`.
 *
 * Takes the raw text rather than an object so the JSON failure and the schema
 * failure come back through one channel: an install refusal has to be able to
 * say which of the two happened.
 */
export function parseThemeManifest(source: string): ManifestParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    return {
      ok: false,
      issues: [`theme.json is not valid JSON: ${(cause as Error).message}`],
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["theme.json must contain a JSON object"] };
  }

  const parsed = themeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "theme.json"}: ${issue.message}`,
      ),
    };
  }

  return {
    ok: true,
    manifest: parsed.data,
    raw: raw as Record<string, unknown>,
  };
}

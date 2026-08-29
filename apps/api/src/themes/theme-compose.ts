import { createHash } from "node:crypto";

import {
  parseVersion,
  type ThemeArchiveFiles,
  type ThemeManifest,
  themeManifestSchema,
  THEME_MANIFEST_FILE,
  writeThemeArchive,
} from "@openbrf/theme-tools";
import { TOKEN_CONTRACT_VERSION } from "@openbrf/tokens";

/**
 * A theme composed on the instance itself.
 *
 * The composer writes the same artefact a catalog publishes - a manifest, and a
 * package holding it - so everything downstream of this file is the install
 * path unchanged: the same lint gate, the same staging, the same row. What a
 * composed theme does not have is a catalog entry, and that absence is the
 * whole marking: a null `catalogId` is what says a theme was authored here.
 *
 * Only colour values are composed. Radius, shadow, motion and the typefaces are
 * absent from the manifest and therefore inherit, and `fonts` is empty because
 * a font is a file with a licence and there is nothing here to upload one
 * through. `viewVariants` is empty as well, which is not the same as inheriting
 * the parent's choice: view variants are read from the theme's own row rather
 * than resolved along the chain, so a composed child of a theme that selects a
 * layout renders the core's default layout instead.
 */

/** What the audit entry names as the source of a composed theme. */
export const COMPOSED_AUDIT_SOURCE = "composer";

/** What the composer submits: an identity, a parent, and colour overrides. */
export interface ComposeThemeInput {
  id: string;
  displayName: string;
  description?: string | undefined;
  /** The theme this one inherits from. Required: a composed theme is a child. */
  extends: string;
  modes: {
    light: Readonly<Record<string, string>>;
    dark: Readonly<Record<string, string>>;
  };
}

export interface ComposedTheme {
  manifest: ThemeManifest;
  files: ThemeArchiveFiles;
  /** The manifest as it was written, for the lint's unknown-field rule. */
  raw: Record<string, unknown>;
}

export type ComposeResult =
  | { ok: true; composed: ComposedTheme }
  | { ok: false; issues: readonly string[] };

/**
 * The version a compose writes.
 *
 * A first compose is 1.0.0 and every edit is a patch bump. The composer cannot
 * express a breaking change - it changes colour values within one contract - so
 * the patch position is the honest one, and bumping at all is what makes an
 * edit visible in the theme list rather than silent.
 *
 * A stored version this arithmetic cannot read starts again at 1.0.0 rather
 * than blocking the edit: the version is a label on the instance's own row, and
 * refusing to save because of it would help nobody.
 */
export function nextComposedVersion(previous: string | null): string {
  if (previous === null) {
    return "1.0.0";
  }
  const parsed = parseVersion(previous);
  if (parsed === null) {
    return "1.0.0";
  }
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch + 1)}`;
}

/** Where a composed theme records that it came from this instance. */
export function composedSourceUrl(themeId: string): string {
  return `composed://${themeId}`;
}

/**
 * The sha512 the row records for a composed theme.
 *
 * The column is not null, and it means the same thing here as it does for a
 * downloaded package: these are the bytes that were written. `writeThemeArchive`
 * is deterministic, so composing the same values twice produces the same digest
 * and a checksum that changes is a theme whose files changed.
 */
export function composedChecksum(files: ThemeArchiveFiles): string {
  return createHash("sha512").update(writeThemeArchive(files)).digest("hex");
}

/**
 * Builds the manifest and the one-file package a compose installs.
 *
 * Validated against the same schema `parseThemeManifest` uses, and refused in
 * the same `path: message` shape, because the composer is a second author of
 * theme.json and a manifest this core would refuse from a catalog has no
 * business being written by the instance either.
 */
export function composedManifest(
  input: ComposeThemeInput,
  previousVersion: string | null,
): ComposeResult {
  const description = input.description?.trim() ?? "";

  const raw: Record<string, unknown> = {
    name: input.id,
    displayName: input.displayName.trim(),
    version: nextComposedVersion(previousVersion),
    contract: `^${TOKEN_CONTRACT_VERSION}`,
    extends: input.extends,
    ...(description === "" ? {} : { description }),
    modes: {
      light: sortedValues(input.modes.light),
      dark: sortedValues(input.modes.dark),
    },
    fonts: [],
    viewVariants: {},
  };

  const parsed = themeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) =>
          `${issue.path.join(".") || THEME_MANIFEST_FILE}: ${issue.message}`,
      ),
    };
  }

  const files: ThemeArchiveFiles = new Map([
    [
      THEME_MANIFEST_FILE,
      new TextEncoder().encode(`${JSON.stringify(raw, null, 2)}\n`),
    ],
  ]);

  return { ok: true, composed: { manifest: parsed.data, files, raw } };
}

/**
 * Token values in a fixed order.
 *
 * The browser sends whatever order the form produced. Sorting here is what
 * makes the written manifest - and therefore the checksum over it - depend on
 * the values a board chose and on nothing else.
 */
function sortedValues(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const name of Object.keys(values).sort()) {
    const value = values[name];
    if (value !== undefined) {
      sorted[name] = value;
    }
  }
  return sorted;
}

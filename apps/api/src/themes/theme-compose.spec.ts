import { parseThemeManifest } from "@openbrf/theme-tools";
import { TOKEN_CONTRACT_VERSION } from "@openbrf/tokens";
import { describe, expect, it } from "vitest";

import {
  composedChecksum,
  composedManifest,
  composedSourceUrl,
  nextComposedVersion,
  type ComposeThemeInput,
} from "./theme-compose";

/**
 * The manifest a composed theme is written as.
 *
 * The composer is a second author of theme.json, so what it writes has to be a
 * manifest this core would accept from a catalog: the same schema, the same
 * contract range, and a package the archive writer can pack deterministically.
 * Anything less would mean a theme that installs from the composer and would be
 * refused if it were published, which is the difference the lint gate exists to
 * remove.
 */

function input(overrides: Partial<ComposeThemeInput> = {}): ComposeThemeInput {
  return {
    id: "husets-farger",
    displayName: "Husets farger",
    extends: "porttavlan",
    modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
    ...overrides,
  };
}

/** The composed package, or a failure the test wants to see as a failure. */
function composed(value: ComposeThemeInput, previousVersion: string | null) {
  const result = composedManifest(value, previousVersion);
  if (!result.ok) {
    throw new Error(`The compose was refused: ${result.issues.join("; ")}`);
  }
  return result.composed;
}

describe("the version a compose writes", () => {
  it("starts at 1.0.0 and bumps the patch on every edit", () => {
    expect(nextComposedVersion(null)).toBe("1.0.0");
    expect(nextComposedVersion("1.0.0")).toBe("1.0.1");
    expect(nextComposedVersion("2.7.19")).toBe("2.7.20");
  });

  /*
   * The version is a label on this instance's own row. Refusing to save an edit
   * because the stored version cannot be read would block the board from fixing
   * the theme, which is the opposite of what the label is for.
   */
  it("starts again at 1.0.0 when the stored version cannot be read", () => {
    expect(nextComposedVersion("not-a-version")).toBe("1.0.0");
  });

  it("carries the bumped version into the manifest", () => {
    expect(composed(input(), null).manifest.version).toBe("1.0.0");
    expect(composed(input(), "1.4.9").manifest.version).toBe("1.4.10");
  });
});

describe("what the manifest states", () => {
  it("is written against the contract this core implements", () => {
    expect(composed(input(), null).manifest.contract).toBe(
      `^${TOKEN_CONTRACT_VERSION}`,
    );
  });

  /*
   * Fonts need a file and a licence, and there is nothing here to upload one
   * through; view variants are read from a theme's own row rather than resolved
   * along the chain, so an empty selection means the core's default layout
   * rather than the parent's choice.
   */
  it("bundles no fonts and selects no view variants", () => {
    const manifest = composed(input(), null).manifest;
    expect(manifest.fonts).toEqual([]);
    expect(manifest.viewVariants).toEqual({});
    expect(manifest.logo).toBeUndefined();
  });

  it("keeps only the values the composer stated", () => {
    const manifest = composed(input(), null).manifest;
    expect(manifest.extends).toBe("porttavlan");
    expect(manifest.modes.light).toEqual({ "accent-trust": "#2F5D50" });
    expect(manifest.modes.dark).toEqual({});
  });

  it("omits a description nobody wrote rather than storing an empty one", () => {
    expect(
      composed(input({ description: "   " }), null).manifest.description,
    ).toBeUndefined();
    expect(
      composed(input({ description: " Varmare brass " }), null).manifest
        .description,
    ).toBe("Varmare brass");
  });
});

describe("the package it writes", () => {
  it("holds the manifest and nothing else", () => {
    const { files } = composed(input(), null);
    expect([...files.keys()]).toEqual(["theme.json"]);
  });

  /*
   * Read back through the same parser the install path uses. A manifest that
   * only this file could read would be one the lint measured and the store
   * wrote without either of them agreeing on what it said.
   */
  it("writes a theme.json the install path can read", () => {
    const { files } = composed(input(), null);
    const contents = files.get("theme.json");
    expect(contents).toBeDefined();

    const parsed = parseThemeManifest(
      new TextDecoder().decode(contents ?? new Uint8Array()),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.name).toBe("husets-farger");
      expect(parsed.manifest.displayName).toBe("Husets farger");
    }
  });

  /*
   * The checksum column is not null and means the same thing here as for a
   * downloaded package: these are the bytes that were written. The form sends
   * values in whatever order it rendered them, so the digest has to depend on
   * the values and not on that order.
   */
  it("digests the same values to the same checksum whatever order they arrive in", () => {
    const first = composed(
      input({
        modes: {
          light: { "accent-trust": "#2F5D50", "surface-page": "#EFEDE7" },
          dark: {},
        },
      }),
      null,
    );
    const second = composed(
      input({
        modes: {
          light: { "surface-page": "#EFEDE7", "accent-trust": "#2F5D50" },
          dark: {},
        },
      }),
      null,
    );

    expect(composedChecksum(first.files)).toBe(composedChecksum(second.files));
    expect(composedChecksum(first.files)).toMatch(/^[0-9a-f]{128}$/);
  });

  it("digests a changed value to a different checksum", () => {
    const before = composed(input(), null);
    const after = composed(
      input({ modes: { light: { "accent-trust": "#2F5D51" }, dark: {} } }),
      null,
    );
    expect(composedChecksum(before.files)).not.toBe(
      composedChecksum(after.files),
    );
  });

  it("names the instance as the source rather than a place to fetch from", () => {
    expect(composedSourceUrl("husets-farger")).toBe("composed://husets-farger");
  });
});

describe("what it refuses", () => {
  it("names the field, in the shape a manifest refusal already travels in", () => {
    const result = composedManifest(input({ id: "Husets Farger" }), null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain(
        "name: must be lowercase words joined by hyphens",
      );
    }
  });

  it("refuses a token value longer than a manifest may carry", () => {
    const result = composedManifest(
      input({
        modes: { light: { "accent-trust": "#".repeat(201) }, dark: {} },
      }),
      null,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) =>
          issue.startsWith("modes.light.accent-trust:"),
        ),
      ).toBe(true);
    }
  });

  it("refuses a display name nobody wrote", () => {
    const result = composedManifest(input({ displayName: "   " }), null);
    expect(result.ok).toBe(false);
  });
});

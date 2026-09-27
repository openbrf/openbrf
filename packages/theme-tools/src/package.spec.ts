import { describe, expect, it } from "vitest";

import { writeThemeArchive } from "./archive.ts";
import type { ThemeChainEntry } from "./inherit.ts";
import {
  lintThemeAgainst,
  lintThemePackage,
  readThemePackage,
} from "./package.ts";

/**
 * The check a theme's own CI and the catalog run on a packed theme, and the
 * one the instance runs at install.
 *
 * Built from archives rather than manifests, because what is listed is a
 * tarball: a check that read the working tree could pass a package that was
 * packed without the files it declares.
 */

const encoder = new TextEncoder();

/** The example theme's manifest, as the fixture in the repository has it. */
function exampleManifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: "example-theme",
    displayName: "Example",
    version: "1.0.0",
    contract: "^1.0.0",
    extends: "porttavlan",
    modes: {
      light: {
        "accent-trust": "#2F5D50",
        "accent-trust-hover": "#264C42",
        "accent-trust-soft": "#DCE8E4",
        "accent-trust-register": "#7FBFAA",
        "on-accent-trust": "#FFFFFF",
      },
      dark: {
        "accent-trust": "#7FBFAA",
        "accent-trust-hover": "#93CCB9",
        "accent-trust-soft": "#1E2E29",
        "accent-trust-register": "#7FBFAA",
        "on-accent-trust": "#17181A",
      },
    },
    fonts: [
      {
        family: "Spline Sans Mono",
        license: "OFL-1.1",
        licenseFile: "fonts/OFL.txt",
        files: [
          {
            path: "fonts/spline-sans-mono-latin.woff2",
            weight: "400 700",
            style: "normal",
          },
        ],
      },
    ],
    viewVariants: { memberRegister: "table" },
    ...overrides,
  };
}

function archiveOf(
  manifest: unknown,
  extra: Record<string, string> = {
    "fonts/spline-sans-mono-latin.woff2": "wOF2",
    "fonts/OFL.txt": "SIL Open Font License 1.1",
  },
): Uint8Array {
  return writeThemeArchive(
    new Map([
      ["theme.json", encoder.encode(JSON.stringify(manifest))],
      ...Object.entries(extra).map(
        ([path, content]) => [path, encoder.encode(content)] as const,
      ),
    ]),
  );
}

/** The register pair at 1.1:1, as the illegible fixture has it. */
const ILLEGIBLE_MODES = {
  light: {
    "text-register": "#202124",
    "text-register-secondary": "#1F2023",
  },
  dark: {
    "text-register": "#151618",
    "text-register-secondary": "#141517",
  },
};

describe("lintThemePackage", () => {
  it("passes the example theme with no finding at all", () => {
    const result = lintThemePackage(archiveOf(exampleManifest()));

    if (!result.ok) {
      throw new Error(`Unreadable: ${result.issues.join(", ")}`);
    }
    expect(result.manifest.name).toBe("example-theme");
    expect(result.lint.ok).toBe(true);
    expect(result.lint.findings).toEqual([]);
  });

  it("fails a theme whose register pair falls below 4.5:1", () => {
    // The statutory register is a document the association must be able to
    // produce and read, so contrast there is a refusal and not a warning.
    const result = lintThemePackage(
      archiveOf(
        exampleManifest({ fonts: undefined, modes: ILLEGIBLE_MODES }),
        {},
      ),
    );

    if (!result.ok) {
      throw new Error(`Unreadable: ${result.issues.join(", ")}`);
    }
    expect(result.lint.ok).toBe(false);
    expect(
      result.lint.findings.some(
        (finding) =>
          finding.rule === "contrast" &&
          finding.severity === "error" &&
          finding.detail["statutory"] === true,
      ),
    ).toBe(true);
  });

  it("fails a theme extending one that is not installed", () => {
    const result = lintThemePackage(
      archiveOf(exampleManifest({ extends: "nordic" })),
    );

    if (!result.ok) {
      throw new Error(`Unreadable: ${result.issues.join(", ")}`);
    }
    expect(result.lint.ok).toBe(false);
    expect(result.lint.findings.map((finding) => finding.rule)).toContain(
      "missing-parent",
    );
  });

  it("passes the same theme once its parent is among the installed", () => {
    const nordic: ThemeChainEntry = {
      id: "nordic",
      extends: "porttavlan",
      modes: { light: {}, dark: {} },
    };

    const result = lintThemePackage(
      archiveOf(exampleManifest({ extends: "nordic" })),
      [nordic],
    );

    expect(result.ok && result.lint.ok).toBe(true);
  });

  it("answers an archive with no manifest with the reader's own failure", () => {
    const result = lintThemePackage(
      writeThemeArchive(new Map([["fonts/OFL.txt", encoder.encode("x")]])),
    );

    expect(result).toMatchObject({ ok: false, reason: "manifest-missing" });
  });
});

describe("lintThemeAgainst", () => {
  it("measures the candidate rather than an installed theme of the same id", () => {
    // A reinstall replaces what is installed under the id, so the version
    // already there must not be what the chain resolves to.
    const read = readThemePackage(
      archiveOf(
        exampleManifest({ fonts: undefined, modes: ILLEGIBLE_MODES }),
        {},
      ),
    );
    if (!read.ok) {
      throw new Error(`Unreadable: ${read.issues.join(", ")}`);
    }
    const legibleInstalledCopy: ThemeChainEntry = {
      id: "example-theme",
      extends: "porttavlan",
      modes: { light: {}, dark: {} },
    };

    expect(lintThemeAgainst(read.package, [legibleInstalledCopy]).ok).toBe(
      false,
    );
  });
});

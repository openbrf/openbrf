import { PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { describe, expect, it } from "vitest";

import {
  BUILT_IN_THEME,
  resolveThemeChain,
  type ThemeChainEntry,
} from "./inherit.ts";
import { chainEntryFor, lintTheme, type ThemeLintRule } from "./lint.ts";
import { parseThemeManifest, type ThemeManifest } from "./manifest.ts";

/**
 * The install gate.
 *
 * The refusals below are the ones with consequences a board cannot see from the
 * install screen: a theme that makes the statutory register illegible, and a
 * theme that fetches a font from a third party and thereby hands every
 * visitor's IP address to it.
 */

function manifestOf(overrides: Record<string, unknown> = {}): ThemeManifest {
  const parsed = parseThemeManifest(
    JSON.stringify({
      name: "example-theme",
      displayName: "Example",
      version: "1.0.0",
      contract: "^1.0.0",
      extends: "porttavlan",
      modes: { light: {}, dark: {} },
      ...overrides,
    }),
  );
  if (!parsed.ok) {
    throw new Error(`Test manifest is invalid: ${parsed.issues.join(", ")}`);
  }
  return parsed.manifest;
}

function lint(
  manifest: ThemeManifest,
  options: {
    files?: readonly string[];
    installed?: readonly ThemeChainEntry[];
    raw?: Record<string, unknown>;
    contractVersion?: string;
  } = {},
) {
  const entries = [
    BUILT_IN_THEME,
    chainEntryFor(manifest),
    ...(options.installed ?? []),
  ];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  return lintTheme({
    manifest,
    files: options.files ?? ["theme.json"],
    chain: resolveThemeChain(manifest.name, (id) => byId.get(id)),
    ...(options.raw === undefined ? {} : { rawManifest: options.raw }),
    ...(options.contractVersion === undefined
      ? {}
      : { contractVersion: options.contractVersion }),
  });
}

function rules(result: {
  findings: readonly { rule: ThemeLintRule }[];
}): ThemeLintRule[] {
  return result.findings.map((finding) => finding.rule);
}

describe("lintTheme", () => {
  it("passes a theme that only changes the accent", () => {
    const result = lint(
      manifestOf({
        modes: {
          light: { "accent-trust": "#2F5D50", "on-accent-trust": "#FFFFFF" },
          dark: { "accent-trust": "#8FC7B4", "on-accent-trust": "#17181A" },
        },
      }),
    );

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.resolved?.light["accent-trust"]).toBe("#2F5D50");
    // Inherited values survive resolution.
    expect(result.resolved?.light["surface-page"]).toBe(
      PORTTAVLAN_LIGHT["surface-page"],
    );
  });

  it("refuses a theme that makes the statutory register illegible", () => {
    // Near-black text on the near-black register board: 1.1:1, far under AA.
    const result = lint(
      manifestOf({
        modes: { light: { "text-register": "#202124" }, dark: {} },
      }),
    );

    expect(result.ok).toBe(false);
    const contrast = result.findings.filter(
      (finding) => finding.rule === "contrast",
    );
    expect(contrast.length).toBeGreaterThan(0);
    expect(
      contrast.some(
        (finding) =>
          finding.detail["statutory"] === true &&
          finding.detail["foreground"] === "text-register",
      ),
    ).toBe(true);
  });

  it("refuses a room pair that fails AA, not only the register ones", () => {
    const result = lint(
      manifestOf({
        modes: { light: { "text-secondary": "#C9C6BE" }, dark: {} },
      }),
    );

    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (finding) =>
          finding.rule === "contrast" &&
          finding.detail["foreground"] === "text-secondary" &&
          finding.detail["statutory"] === false,
      ),
    ).toBe(true);
  });

  it("checks both modes, not only the one that happens to be rendering", () => {
    const result = lint(
      manifestOf({
        modes: { light: {}, dark: { "text-register": "#111214" } },
      }),
    );

    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (finding) =>
          finding.rule === "contrast" && finding.detail["mode"] === "dark",
      ),
    ).toBe(true);
  });

  /*
   * The reason the lint exists at all. Loading a font from a third party
   * discloses every visitor's IP address to it, which is a GDPR problem in the
   * EU, so a theme's fonts are bundled and never fetched.
   */
  it("refuses a font path that points at a font CDN", () => {
    // The path schema is the first line: a URL is not a path inside a package.
    const parsed = parseThemeManifest(
      JSON.stringify({
        name: "example-theme",
        displayName: "Example",
        version: "1.0.0",
        contract: "^1.0.0",
        fonts: [
          {
            family: "Inter",
            license: "OFL-1.1",
            files: [{ path: "https://fonts.example.com/inter.woff2" }],
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.issues.join(" ")).toMatch(/relative path inside the theme/);
  });

  it("refuses a font family naming a remote source", () => {
    // The second line, for the one font field that is free text.
    const result = lint(
      manifestOf({
        fonts: [
          {
            family: "https://fonts.example.com/css?family=Inter",
            license: "OFL-1.1",
            files: [{ path: "fonts/inter.woff2" }],
          },
        ],
      }),
      { files: ["theme.json", "fonts/inter.woff2"] },
    );

    expect(result.ok).toBe(false);
    expect(rules(result)).toContain("font-remote-source");
  });

  it("refuses a declared font file the package does not contain", () => {
    const result = lint(
      manifestOf({
        fonts: [
          {
            family: "Inter",
            license: "OFL-1.1",
            files: [{ path: "fonts/inter.woff2" }],
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(rules(result)).toContain("font-file-missing");
  });

  it("refuses a font file the manifest never declared a licence for", () => {
    const result = lint(manifestOf(), {
      files: ["theme.json", "fonts/smuggled.woff2"],
    });

    expect(result.ok).toBe(false);
    expect(rules(result)).toContain("font-file-undeclared");
  });

  it("accepts a bundled font with its licence stated", () => {
    const result = lint(
      manifestOf({
        fonts: [
          {
            family: "Inter",
            license: "OFL-1.1",
            licenseFile: "fonts/OFL.txt",
            files: [{ path: "fonts/inter-400.woff2", weight: "400" }],
          },
        ],
      }),
      { files: ["theme.json", "fonts/inter-400.woff2", "fonts/OFL.txt"] },
    );

    expect(result.findings).toEqual([]);
  });

  it("refuses a licence file the package does not contain", () => {
    const result = lint(
      manifestOf({
        fonts: [
          {
            family: "Inter",
            license: "OFL-1.1",
            licenseFile: "fonts/OFL.txt",
            files: [{ path: "fonts/inter-400.woff2" }],
          },
        ],
      }),
      { files: ["theme.json", "fonts/inter-400.woff2"] },
    );

    expect(rules(result)).toContain("license-file-missing");
  });

  /*
   * A theme is data. Code in the package means it is a UI plugin, which is a
   * different contract with a different review.
   */
  it("refuses a package carrying anything executable", () => {
    for (const file of ["theme.js", "index.html", "extra.css", "logo.svg"]) {
      const result = lint(manifestOf(), { files: ["theme.json", file] });
      expect(rules(result)).toContain("executable-content");
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a file type the format does not know", () => {
    const result = lint(manifestOf(), { files: ["theme.json", "payload.bin"] });
    expect(rules(result)).toContain("unexpected-file");
  });

  it("refuses the default theme's reserved id", () => {
    const result = lint(manifestOf({ name: "porttavlan", extends: null }));
    expect(rules(result)).toContain("reserved-id");
  });

  it("refuses a contract range this core does not satisfy", () => {
    const result = lint(manifestOf({ contract: "^2.0.0" }));
    expect(rules(result)).toContain("contract-incompatible");
  });

  it("refuses a view variant the core does not maintain", () => {
    const result = lint(
      manifestOf({ viewVariants: { memberRegister: "cards" } }),
    );
    expect(rules(result)).toContain("unknown-view-variant");
  });

  it("accepts the view variant the core does maintain", () => {
    const result = lint(
      manifestOf({ viewVariants: { memberRegister: "table" } }),
    );
    expect(result.findings).toEqual([]);
  });

  it("refuses a token value that would escape its declaration", () => {
    const result = lint(
      manifestOf({
        modes: {
          light: {
            "accent-trust": "#fff; } :root { --obrf-text-register: #111",
          },
          dark: {},
        },
      }),
    );
    expect(rules(result)).toContain("unsafe-token-value");
    expect(result.ok).toBe(false);
  });

  it("refuses a token value that would fetch over the network", () => {
    const result = lint(
      manifestOf({
        modes: {
          light: { "shadow-raised": "url(https://tracker.example.com/x.png)" },
          dark: {},
        },
      }),
    );
    expect(rules(result)).toContain("unsafe-token-value");
  });

  it("refuses a bundled font whose licence is only whitespace", () => {
    // The schema demands the field; this is what reads it as a statement. A
    // font redistributed under a licence nobody can check is the thing the rule
    // exists to stop.
    const result = lint(
      manifestOf({
        fonts: [
          {
            family: "Inter",
            license: " ",
            files: [{ path: "fonts/inter-400.woff2" }],
          },
        ],
      }),
      { files: ["theme.json", "fonts/inter-400.woff2"] },
    );

    expect(result.ok).toBe(false);
    expect(rules(result)).toContain("font-license-missing");
  });

  it("refuses a theme whose parent is not installed", () => {
    const result = lint(manifestOf({ extends: "never-installed" }));
    expect(rules(result)).toContain("missing-parent");
    expect(result.resolved).toBeNull();
  });

  /*
   * The two rules that bound chain walking. `extends` is author-supplied, so
   * without them resolution would follow a loop until the process died.
   */
  it("refuses a theme that names itself as its parent", () => {
    const result = lint(manifestOf({ extends: "example-theme" }));
    expect(rules(result)).toContain("self-extends");
    expect(rules(result)).toContain("inheritance-cycle");
    expect(result.resolved).toBeNull();
  });

  it("refuses two themes that name each other", () => {
    const other: ThemeChainEntry = {
      id: "other-theme",
      extends: "example-theme",
      modes: { light: {}, dark: {} },
    };
    const result = lint(manifestOf({ extends: "other-theme" }), {
      installed: [other],
    });

    expect(rules(result)).toContain("inheritance-cycle");
    expect(result.resolved).toBeNull();
  });

  it("refuses a root theme that leaves a required token unstated", () => {
    const result = lint(manifestOf({ extends: null }));
    expect(rules(result)).toContain("missing-token");
    expect(result.resolved).toBeNull();
  });

  /*
   * Forward compatibility, the other direction. A theme built against a later
   * minor may state a token this core has never heard of; the contract promises
   * that still installs, so this is a warning and the value is ignored.
   */
  it("warns about a token it does not know rather than refusing", () => {
    const result = lint(
      manifestOf({
        modes: { light: { "surface-holographic": "#FFFFFF" }, dark: {} },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([
      {
        rule: "unknown-token",
        severity: "warning",
        detail: { mode: "light", token: "surface-holographic" },
      },
    ]);
  });

  it("warns about a manifest field it does not know", () => {
    const manifest = manifestOf();
    const result = lint(manifest, {
      raw: { name: manifest.name, somethingNewer: true },
    });

    expect(result.ok).toBe(true);
    expect(rules(result)).toEqual(["unknown-manifest-field"]);
  });

  it("resolves through a grandparent", () => {
    const parent: ThemeChainEntry = {
      id: "parent-theme",
      extends: "porttavlan",
      modes: { light: { "radius-panel": "0px" }, dark: {} },
    };
    const result = lint(
      manifestOf({
        name: "child-theme",
        extends: "parent-theme",
        modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
      }),
      { installed: [parent] },
    );

    expect(result.ok).toBe(true);
    expect(result.resolved?.light["radius-panel"]).toBe("0px");
    expect(result.resolved?.light["accent-trust"]).toBe("#2F5D50");
  });
});

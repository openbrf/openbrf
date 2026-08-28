import { describe, expect, it } from "vitest";

import { isPackagePath, parseThemeManifest } from "./manifest.ts";

/**
 * The manifest is the boundary between a theme author and this codebase.
 *
 * Two properties are load-bearing. It must reject what it cannot safely handle
 * - above all a path that would escape the theme's own directory once written
 * to disk. And it must accept fields it does not understand, because that is
 * what lets a theme written against a later contract install here at all.
 */

const VALID = {
  name: "example-theme",
  displayName: "Example",
  version: "1.0.0",
  contract: "^1.0.0",
  extends: "porttavlan",
  modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseThemeManifest(JSON.stringify({ ...VALID, ...overrides }));
}

describe("parseThemeManifest", () => {
  it("reads a minimal theme", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.name).toBe("example-theme");
    expect(result.manifest.extends).toBe("porttavlan");
    expect(result.manifest.modes.light["accent-trust"]).toBe("#2F5D50");
    // Absent collections arrive as empty ones, so no caller has to guess.
    expect(result.manifest.fonts).toEqual([]);
    expect(result.manifest.viewVariants).toEqual({});
  });

  it("names the failure when the file is not JSON", () => {
    const result = parseThemeManifest("{ not json");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues[0]).toMatch(/not valid JSON/);
  });

  it("refuses an id that is not lowercase words joined by hyphens", () => {
    expect(parse({ name: "Example Theme" }).ok).toBe(false);
    expect(parse({ name: "example_theme" }).ok).toBe(false);
  });

  it("refuses a version range where a version belongs", () => {
    expect(parse({ version: "^1.0.0" }).ok).toBe(false);
  });

  it("refuses a contract range it cannot read", () => {
    expect(parse({ contract: "latest" }).ok).toBe(false);
  });

  it("refuses an asset path that escapes the package", () => {
    expect(parse({ logo: "../../etc/passwd" }).ok).toBe(false);
    expect(parse({ logo: "/etc/passwd" }).ok).toBe(false);
    expect(parse({ logo: "fonts\\body.woff2" }).ok).toBe(false);
  });

  it("requires a licence on every bundled font", () => {
    const withoutLicence = parse({
      fonts: [{ family: "Inter", files: [{ path: "fonts/inter.woff2" }] }],
    });
    expect(withoutLicence.ok).toBe(false);

    const withLicence = parse({
      fonts: [
        {
          family: "Inter",
          license: "OFL-1.1",
          files: [{ path: "fonts/inter.woff2" }],
        },
      ],
    });
    expect(withLicence.ok).toBe(true);
    if (!withLicence.ok) {
      return;
    }
    expect(withLicence.manifest.fonts[0]?.files[0]?.weight).toBe("400");
    expect(withLicence.manifest.fonts[0]?.files[0]?.style).toBe("normal");
  });

  /*
   * Forward compatibility. A theme authored against the fuller contract carries
   * `license`, `requires` and `recommends`; phase 1 accepts all three and acts
   * on none of them, so such a theme installs here unchanged.
   */
  it("accepts the fields phase 1 ignores", () => {
    const result = parse({
      license: "CC-BY-4.0",
      requires: { "openbrf-core": ">=1.0.0" },
      recommends: ["some-plugin"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.license).toBe("CC-BY-4.0");
    expect(result.manifest.requires).toEqual({ "openbrf-core": ">=1.0.0" });
  });

  it("keeps an unknown field out of the parsed value but not out of the raw one", () => {
    const result = parse({ somethingNewer: true });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect("somethingNewer" in result.manifest).toBe(false);
    expect(result.raw["somethingNewer"]).toBe(true);
  });
});

describe("isPackagePath", () => {
  it("accepts a relative path inside the package", () => {
    expect(isPackagePath("theme.json")).toBe(true);
    expect(isPackagePath("fonts/body-400.woff2")).toBe(true);
  });

  it("refuses anything that could leave the package", () => {
    expect(isPackagePath("../theme.json")).toBe(false);
    expect(isPackagePath("/theme.json")).toBe(false);
    expect(isPackagePath("fonts//body.woff2")).toBe(false);
    expect(isPackagePath("C:/fonts/body.woff2")).toBe(false);
    expect(isPackagePath("fonts/.hidden")).toBe(false);
    expect(isPackagePath("")).toBe(false);
  });
});

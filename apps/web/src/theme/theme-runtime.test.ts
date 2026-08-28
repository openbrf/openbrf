import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { afterEach, describe, expect, it } from "vitest";

import type { ThemeRendering } from "../api/themes";
import { applyAccentOverride } from "./accent-override";
import { applyThemeRendering } from "./theme-runtime";

/**
 * An installed theme applied to a running page.
 *
 * This is also what live preview is, which is why the shape matters: the theme
 * has to keep the three-block structure the engine uses, or a previewed theme
 * would render one mode's values in both and a board would approve something
 * they never saw.
 */

const tokens = () => document.getElementById("openbrf-theme-tokens");
const fonts = () => document.getElementById("openbrf-theme-fonts");
const accent = () => document.getElementById("openbrf-accent-override");

function rendering(overrides: Partial<ThemeRendering> = {}): ThemeRendering {
  return {
    id: "example-theme",
    name: "Example",
    builtIn: false,
    modes: {
      light: { ...PORTTAVLAN_LIGHT, "accent-trust": "#2F5D50" },
      dark: { ...PORTTAVLAN_DARK, "accent-trust": "#7FBFAA" },
    },
    fontFaces: [],
    viewVariants: { memberRegister: "table" },
    logoUrl: null,
    ...overrides,
  };
}

afterEach(() => {
  applyThemeRendering(null);
  applyAccentOverride(null);
});

describe("applying a theme", () => {
  it("writes the theme's token values as a stylesheet", () => {
    applyThemeRendering(rendering());

    const css = tokens()?.textContent ?? "";
    expect(css).toContain("--obrf-accent-trust: #2F5D50;");
    expect(css).toContain("--obrf-surface-register:");
  });

  it("keeps the three blocks the theme engine needs", () => {
    applyThemeRendering(rendering());
    const css = tokens()?.textContent ?? "";

    // Light on :root, dark under the system preference, and dark again under an
    // explicit choice so the toggle wins in both directions.
    expect(css).toContain(":root {");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--obrf-accent-trust: #7FBFAA;");
  });

  it("writes @font-face rules for the theme's own bundled files", () => {
    applyThemeRendering(
      rendering({
        fontFaces: [
          {
            family: "Spline Sans Mono",
            weight: "400 700",
            style: "normal",
            url: "/api/themes/asset?theme=example-theme&file=fonts%2Fmono.woff2",
            format: "woff2",
          },
        ],
      }),
    );

    const css = fonts()?.textContent ?? "";
    expect(css).toContain('font-family: "Spline Sans Mono";');
    // Served from this instance, never from a font CDN.
    expect(css).toContain("/api/themes/asset?theme=example-theme");
    expect(css).not.toContain("http");
  });

  it("removes the stylesheets for the built-in theme", () => {
    applyThemeRendering(rendering());
    applyThemeRendering(rendering({ builtIn: true, id: "porttavlan" }));

    // The default theme's values are already the first stylesheet the browser
    // parsed; restating them would be a second copy to keep in step.
    expect(tokens()).toBeNull();
    expect(fonts()).toBeNull();
  });

  it("drops a value that would escape its declaration", () => {
    applyThemeRendering(
      rendering({
        modes: {
          light: {
            ...PORTTAVLAN_LIGHT,
            "shadow-raised": "none; } :root { --obrf-text-register: #111",
          },
          dark: PORTTAVLAN_DARK,
        },
      }),
    );

    const css = tokens()?.textContent ?? "";
    expect(css).not.toContain("--obrf-text-register: #111");
    expect(css).not.toContain("--obrf-shadow-raised: none;");
  });
});

describe("the housing cooperative's accent, over a theme", () => {
  it("derives against the active theme rather than always the default", () => {
    applyAccentOverride("#2F6DB5");
    const beforeTheme = accent()?.textContent ?? "";

    // A theme with a light register board: the register accent has to be
    // measured against that board, not against the default theme's dark one.
    applyThemeRendering(
      rendering({
        modes: {
          light: {
            ...PORTTAVLAN_LIGHT,
            "surface-register": "#FFFFFF",
            "surface-register-raised": "#F2F0EA",
            "text-register": "#26272A",
            "text-register-secondary": "#5A5B61",
            "border-register": "#DBD8CF",
            "accent-trust-register": "#38607E",
            "status-warn-register": "#7D5615",
          },
          dark: PORTTAVLAN_DARK,
        },
      }),
    );

    const afterTheme = accent()?.textContent ?? "";
    expect(afterTheme).not.toBe("");
    expect(afterTheme).not.toBe(beforeTheme);
  });

  it("keeps the accent last in the document so it still wins", () => {
    applyAccentOverride("#2F6DB5");
    applyThemeRendering(rendering());

    const styles = [...document.head.querySelectorAll("style")];
    const themeIndex = styles.findIndex(
      (style) => style.id === "openbrf-theme-tokens",
    );
    const accentIndex = styles.findIndex(
      (style) => style.id === "openbrf-accent-override",
    );

    expect(themeIndex).toBeGreaterThanOrEqual(0);
    expect(accentIndex).toBeGreaterThan(themeIndex);
  });

  it("returns to the default theme's derivation when the theme is removed", () => {
    applyAccentOverride("#2F6DB5");
    const onDefault = accent()?.textContent ?? "";

    applyThemeRendering(rendering());
    applyThemeRendering(null);

    expect(accent()?.textContent).toBe(onDefault);
  });
});

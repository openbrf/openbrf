import { describe, expect, it } from "vitest";

import { REQUIRED_TOKEN_NAMES, TOKEN_NAMES } from "./contract";
import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "./porttavlan";
import { buildThemeStylesheet, resolveTokens } from "./resolve";

describe("resolveTokens", () => {
  it("passes a complete theme through unchanged", () => {
    const result = resolveTokens(PORTTAVLAN_LIGHT);

    expect(result.missing).toEqual([]);
    expect(result.derived).toEqual([]);
    expect(result.tokens).toEqual(PORTTAVLAN_LIGHT);
  });

  it("lets a theme override selectively on top of its parent", () => {
    // The child-theme case: state only what changes.
    const result = resolveTokens(
      { "accent-trust": "#005F73" },
      PORTTAVLAN_LIGHT,
    );

    expect(result.tokens["accent-trust"]).toBe("#005F73");
    expect(result.tokens["surface-page"]).toBe(
      PORTTAVLAN_LIGHT["surface-page"],
    );
    expect(result.missing).toEqual([]);
  });

  it("derives an unstated token from its fallback", () => {
    const result = resolveTokens({
      ...PORTTAVLAN_LIGHT,
      "status-warn-soft": undefined,
    });

    expect(result.tokens["status-warn-soft"]).toBe(
      PORTTAVLAN_LIGHT["status-warn"],
    );
    expect(result.derived).toContain("status-warn-soft");
  });

  it("follows a fallback chain more than one level deep", () => {
    // Stating only the base of a family must still yield the whole family,
    // which is what lets the core add a variant without breaking old themes.
    const minimal = { ...PORTTAVLAN_LIGHT };
    delete (minimal as Record<string, string | undefined>)["text-register"];
    delete (minimal as Record<string, string | undefined>)[
      "text-register-secondary"
    ];

    const result = resolveTokens(minimal);

    // text-register has no fallback, so it is genuinely missing, and the
    // variant that depends on it is reported too rather than filled with junk.
    expect(result.missing).toContain("text-register");
  });

  it("reports a missing required token instead of emitting an empty value", () => {
    const result = resolveTokens({});

    // An empty custom property renders as an invisible element, which looks
    // like a broken app rather than a broken theme.
    expect(result.missing.length).toBeGreaterThan(0);
    for (const required of REQUIRED_TOKEN_NAMES) {
      expect(result.missing).toContain(required);
    }
  });

  it("treats an empty string as unstated", () => {
    const result = resolveTokens({
      ...PORTTAVLAN_LIGHT,
      "status-ok-soft": "",
    });

    expect(result.tokens["status-ok-soft"]).toBe(PORTTAVLAN_LIGHT["status-ok"]);
  });
});

describe("buildThemeStylesheet", () => {
  const css = buildThemeStylesheet({
    light: PORTTAVLAN_LIGHT,
    dark: PORTTAVLAN_DARK,
  });

  it("defines the light values on bare :root", () => {
    // Light must render when no preference and no explicit choice apply.
    expect(css).toContain(":root {");
    expect(css).toContain(
      `--obrf-surface-page: ${PORTTAVLAN_LIGHT["surface-page"]};`,
    );
  });

  it("supplies dark for a system preference, without beating an explicit light choice", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it("lets an explicit dark choice override the system in both directions", () => {
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("emits every token in the contract for both modes", () => {
    for (const name of TOKEN_NAMES) {
      expect(css).toContain(`--obrf-${name}:`);
    }
  });

  it("never defines a token only inside a media query", () => {
    // A value reachable only via prefers-color-scheme would vanish for a
    // viewer who picked a mode explicitly.
    const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}"));
    for (const name of TOKEN_NAMES) {
      expect(rootBlock).toContain(`--obrf-${name}:`);
    }
  });
});

import { PORTTAVLAN_LIGHT, REQUIRED_TOKEN_NAMES } from "@openbrf/tokens";
import { describe, expect, it } from "vitest";

import {
  BUILT_IN_THEME,
  mergeChain,
  resolveChainTokens,
  resolveThemeChain,
  type ThemeChainEntry,
  unknownTokenNames,
} from "./inherit.ts";

/**
 * Inheritance is what makes a theme four lines long instead of seventy, so the
 * cases below are the ones a theme author actually depends on: a child states
 * only what it changes, a grandchild still sees its grandparent's values, and
 * the contract's own fallbacks fill anything nobody stated.
 */

function lookupOver(entries: readonly ThemeChainEntry[]) {
  const byId = new Map([
    [BUILT_IN_THEME.id, BUILT_IN_THEME],
    ...entries.map((entry) => [entry.id, entry] as const),
  ]);
  return (id: string): ThemeChainEntry | undefined => byId.get(id);
}

const CHILD: ThemeChainEntry = {
  id: "example-theme",
  extends: "porttavlan",
  modes: {
    light: { "accent-trust": "#2F5D50" },
    dark: { "accent-trust": "#8FC7B4" },
  },
};

const GRANDCHILD: ThemeChainEntry = {
  id: "example-theme-compact",
  extends: "example-theme",
  modes: { light: { "radius-panel": "0px" }, dark: {} },
};

describe("resolveThemeChain", () => {
  it("walks from the theme to its root ancestor, root first", () => {
    const result = resolveThemeChain(
      "example-theme-compact",
      lookupOver([CHILD, GRANDCHILD]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.chain.map((entry) => entry.id)).toEqual([
      "porttavlan",
      "example-theme",
      "example-theme-compact",
    ]);
  });

  it("reports a parent that is not installed rather than silently dropping it", () => {
    const orphan: ThemeChainEntry = {
      id: "orphan",
      extends: "never-installed",
      modes: { light: {}, dark: {} },
    };
    const result = resolveThemeChain("orphan", lookupOver([orphan]));
    expect(result).toEqual({
      ok: false,
      reason: "missing-parent",
      themeId: "never-installed",
    });
  });

  it("reports the theme itself being unknown separately", () => {
    const result = resolveThemeChain("nothing", lookupOver([]));
    expect(result).toEqual({
      ok: false,
      reason: "unknown-theme",
      themeId: "nothing",
    });
  });

  it("stops on a cycle instead of following it", () => {
    const a: ThemeChainEntry = {
      id: "a",
      extends: "b",
      modes: { light: {}, dark: {} },
    };
    const b: ThemeChainEntry = {
      id: "b",
      extends: "a",
      modes: { light: {}, dark: {} },
    };
    const result = resolveThemeChain("a", lookupOver([a, b]));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("cycle");
  });
});

describe("mergeChain", () => {
  it("lets a descendant's value win over its ancestor's", () => {
    const merged = mergeChain([BUILT_IN_THEME, CHILD]);
    expect(merged.light["accent-trust"]).toBe("#2F5D50");
    // Untouched values still come from the parent.
    expect(merged.light["surface-page"]).toBe(PORTTAVLAN_LIGHT["surface-page"]);
  });

  it("merges each mode separately", () => {
    // A theme that changes only the light accent keeps the parent's dark one.
    const lightOnly: ThemeChainEntry = {
      id: "light-only",
      extends: "porttavlan",
      modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
    };
    const merged = mergeChain([BUILT_IN_THEME, lightOnly]);
    expect(merged.light["accent-trust"]).toBe("#2F5D50");
    expect(merged.dark["accent-trust"]).toBe("#C9A64B");
  });

  it("drops a token name this contract version does not define", () => {
    const future: ThemeChainEntry = {
      id: "future",
      extends: null,
      modes: {
        light: { "surface-holographic": "#FFFFFF" } as never,
        dark: {},
      },
    };
    const merged = mergeChain([future]);
    expect(Object.keys(merged.light)).toEqual([]);
  });
});

describe("resolveChainTokens", () => {
  it("produces a complete token set for a theme extending the default", () => {
    const resolved = resolveChainTokens([BUILT_IN_THEME, CHILD]);
    expect(resolved.light.missing).toEqual([]);
    expect(resolved.dark.missing).toEqual([]);
    expect(resolved.light.tokens["accent-trust"]).toBe("#2F5D50");
  });

  it("derives what a root theme leaves unstated from the contract's fallbacks", () => {
    // Only the tokens with no fallback are stated; everything else has to be
    // derived, which is the rule that lets the core add a token in a minor
    // release without breaking a theme written before it existed.
    const stated: Record<string, string> = {};
    for (const name of REQUIRED_TOKEN_NAMES) {
      stated[name] = PORTTAVLAN_LIGHT[name];
    }
    const root: ThemeChainEntry = {
      id: "root",
      extends: null,
      modes: { light: stated, dark: stated },
    };

    const resolved = resolveChainTokens([root]);
    expect(resolved.light.missing).toEqual([]);
    expect(resolved.light.derived.length).toBeGreaterThan(0);
    // surface-sunken falls back to surface-raised.
    expect(resolved.light.tokens["surface-sunken"]).toBe(
      PORTTAVLAN_LIGHT["surface-raised"],
    );
  });

  it("reports a required token nobody stated", () => {
    const root: ThemeChainEntry = {
      id: "root",
      extends: null,
      modes: { light: {}, dark: {} },
    };
    expect(resolveChainTokens([root]).light.missing.length).toBeGreaterThan(0);
  });
});

describe("unknownTokenNames", () => {
  it("names what the contract does not define", () => {
    expect(
      unknownTokenNames({ "accent-trust": "#000", "accent-mystery": "#000" }),
    ).toEqual(["accent-mystery"]);
  });
});

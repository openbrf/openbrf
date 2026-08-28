import { describe, expect, it } from "vitest";

import {
  buildAccentOverrideStylesheet,
  deriveAccentFamily,
  mixColors,
  normalizeColor,
  primaryColorOverride,
  pushToContrast,
} from "./branding.ts";
import { AA_CONTRAST_RATIO, checkContrast, contrastRatio } from "./contrast.ts";
import { PORTTAVLAN, PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "./porttavlan.ts";

/** Fails the assertion with the measured ratio, which is what a fix needs. */
function expectAA(foreground: string, background: string): void {
  const ratio = contrastRatio(foreground, background);
  expect(
    ratio,
    `${foreground} on ${background} measured ${String(ratio)}`,
  ).toBeGreaterThanOrEqual(AA_CONTRAST_RATIO);
}

describe("mixColors", () => {
  it("returns the ends of the range unchanged", () => {
    expect(mixColors("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixColors("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("mixes halfway in sRGB", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("clamps a weight outside the range rather than extrapolating", () => {
    expect(mixColors("#000000", "#ffffff", -1)).toBe("#000000");
    expect(mixColors("#000000", "#ffffff", 2)).toBe("#ffffff");
  });

  it("returns null for a colour it cannot read", () => {
    expect(mixColors("brass", "#ffffff", 0.5)).toBeNull();
    // A translucent value is refused upstream by parseColor: what it contrasts
    // with depends on whatever is painted behind it.
    expect(mixColors("rgba(0,0,0,0.5)", "#ffffff", 0.5)).toBeNull();
  });
});

describe("pushToContrast", () => {
  it("leaves a colour alone when it already passes", () => {
    const ink = PORTTAVLAN_LIGHT["text-primary"];
    const page = PORTTAVLAN_LIGHT["surface-page"];
    // The default theme's own brass was chosen to pass on the page.
    const brass = PORTTAVLAN_LIGHT["accent-trust"];

    // Compared case-insensitively: the derivation canonicalises to lowercase
    // hex, and the palette states its values in upper case.
    expect(pushToContrast(brass, ink, [page])?.toLowerCase()).toBe(
      brass.toLowerCase(),
    );
  });

  it("darkens a light colour in the light mode", () => {
    // The dark mode's brass, which is too light to read on the light page.
    const result = pushToContrast("#C9A64B", PORTTAVLAN_LIGHT["text-primary"], [
      PORTTAVLAN_LIGHT["surface-page"],
      PORTTAVLAN_LIGHT["surface-raised"],
    ]);

    expect(result).not.toBeNull();
    expectAA(result ?? "", PORTTAVLAN_LIGHT["surface-page"]);
    expectAA(result ?? "", PORTTAVLAN_LIGHT["surface-raised"]);
  });

  it("stops at the bound rather than mixing a colour away entirely", () => {
    const backgrounds = [PORTTAVLAN_LIGHT["surface-page"]];
    const ink = PORTTAVLAN_LIGHT["text-primary"];

    // A pale yellow needs more than the bound allows, so it is refused...
    expect(pushToContrast("#FFE066", ink, backgrounds)).toBeNull();
    // ...and raising the bound is what would accept it, which is the point:
    // the refusal is the bound doing its job, not an unreachable ratio.
    expect(pushToContrast("#FFE066", ink, backgrounds, 0.95)).not.toBeNull();
  });

  it("lightens a dark colour in the dark mode, from the same rule", () => {
    // Same input colour, opposite adjustment, because the mode's ink differs.
    const result = pushToContrast("#123A5B", PORTTAVLAN_DARK["text-primary"], [
      PORTTAVLAN_DARK["surface-page"],
      PORTTAVLAN_DARK["surface-raised"],
    ]);

    expect(result).not.toBeNull();
    expectAA(result ?? "", PORTTAVLAN_DARK["surface-page"]);
  });

  it("returns null when no mix along the ink axis passes", () => {
    // Mixing towards the page's own colour can never separate from the page.
    const page = PORTTAVLAN_LIGHT["surface-page"];
    expect(pushToContrast(page, page, [page])).toBeNull();
  });
});

describe("deriveAccentFamily", () => {
  /** Unwraps a derivation the test expects to have succeeded. */
  function familyOf(colour: string, base: typeof PORTTAVLAN_LIGHT) {
    const derivation = deriveAccentFamily(colour, base);
    expect(derivation.ok).toBe(true);
    if (!derivation.ok) {
      throw new Error(`${colour} was refused on the ${derivation.surface}`);
    }
    return derivation.family;
  }

  it("produces every accent token, all of them legible", () => {
    const family = familyOf("#2F6DB5", PORTTAVLAN_LIGHT);

    expectAA(family["accent-trust"], PORTTAVLAN_LIGHT["surface-page"]);
    expectAA(family["accent-trust"], PORTTAVLAN_LIGHT["surface-raised"]);
    expectAA(family["on-accent-trust"], family["accent-trust"]);
    expectAA(
      family["accent-trust-register"],
      PORTTAVLAN_LIGHT["surface-register"],
    );
    expectAA(
      family["accent-trust-register"],
      PORTTAVLAN_LIGHT["surface-register-raised"],
    );
  });

  it("derives the register variant for the register surface, not the room", () => {
    // The whole reason accent-trust-register exists: the same colour has to
    // read on a dark board, and the room-side value does not.
    const family = familyOf("#7D5F23", PORTTAVLAN_LIGHT);

    expect(family["accent-trust-register"]).not.toBe(family["accent-trust"]);
    expectAA(
      family["accent-trust-register"],
      PORTTAVLAN_LIGHT["surface-register"],
    );
  });

  it("picks the lettering colour from the theme's own palette", () => {
    // A dark brass ground takes the light lettering the theme already defines.
    expect(familyOf("#7D5F23", PORTTAVLAN_LIGHT)["on-accent-trust"]).toBe(
      PORTTAVLAN_LIGHT["on-accent-trust"],
    );
    // A pale ground in the dark mode takes the dark lettering instead, which is
    // measured rather than assumed - but always from the palette.
    expect(familyOf("#C9A64B", PORTTAVLAN_DARK)["on-accent-trust"]).toBe(
      PORTTAVLAN_DARK["on-accent-trust"],
    );
  });

  it("says which surface defeated a colour it cannot use", () => {
    const derivation = deriveAccentFamily(
      PORTTAVLAN_LIGHT["surface-page"],
      PORTTAVLAN_LIGHT,
    );

    expect(derivation.ok).toBe(false);
    if (derivation.ok) {
      return;
    }
    expect(derivation.surface).toBe("room");
  });
});

describe("primaryColorOverride", () => {
  it("accepts the default theme's own brass unchanged", () => {
    const result = primaryColorOverride("#7D5F23", PORTTAVLAN);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.override.light["accent-trust"]).toBe("#7d5f23");
  });

  it("canonicalises the colour it was given", () => {
    const asHex = primaryColorOverride("#7d5f23", PORTTAVLAN);
    const asRgb = primaryColorOverride("rgb(125, 95, 35)", PORTTAVLAN);

    expect(asHex.ok && asRgb.ok).toBe(true);
    if (!asHex.ok || !asRgb.ok) {
      return;
    }
    expect(asRgb.override.light).toEqual(asHex.override.light);
  });

  it("derives a different family per mode from one chosen colour", () => {
    const result = primaryColorOverride("#7D5F23", PORTTAVLAN);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The dark mode has to lighten it; that is the whole point of two modes.
    expect(result.override.dark["accent-trust"]).not.toBe(
      result.override.light["accent-trust"],
    );
    expectAA(
      result.override.dark["accent-trust"],
      PORTTAVLAN_DARK["surface-page"],
    );
  });

  it("holds AA on every contract pair, in both modes", () => {
    for (const colour of ["#2F6DB5", "#A03329", "#366B3E", "#6B4FA0"]) {
      const result = primaryColorOverride(colour, PORTTAVLAN);
      expect(result.ok, `${colour} was refused`).toBe(true);
      if (!result.ok) {
        continue;
      }
      for (const mode of [PORTTAVLAN_LIGHT, PORTTAVLAN_DARK] as const) {
        const family =
          mode === PORTTAVLAN_LIGHT
            ? result.override.light
            : result.override.dark;
        expect(checkContrast({ ...mode, ...family })).toEqual([]);
      }
    }
  });

  it("refuses a value that is not a colour", () => {
    const result = primaryColorOverride("skyblue-ish", PORTTAVLAN);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.problem.reason).toBe("unreadable-colour");
  });

  it("refuses a translucent colour instead of guessing its backdrop", () => {
    const result = primaryColorOverride("rgba(125, 95, 35, 0.4)", PORTTAVLAN);

    expect(result.ok).toBe(false);
  });

  it("refuses a colour too pale to read, with the measured ratio", () => {
    // A pale yellow measures about 1.1 to 1 on the limewash page, and the
    // bounded search will not darken it into an olive the board never chose.
    const result = primaryColorOverride("#FFE066", PORTTAVLAN);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.problem.reason).toBe("fails-contrast");
    if (result.problem.reason !== "fails-contrast") {
      return;
    }
    const [finding] = result.problem.findings;
    expect(finding?.background).toBe("surface-page");
    expect(finding?.ratio ?? 0).toBeLessThan(AA_CONTRAST_RATIO);
  });

  it("refuses the page colour itself", () => {
    const result = primaryColorOverride(
      PORTTAVLAN_LIGHT["surface-page"],
      PORTTAVLAN,
    );

    expect(result.ok).toBe(false);
  });
});

describe("buildAccentOverrideStylesheet", () => {
  it("states the accent tokens in all three blocks", () => {
    const result = primaryColorOverride("#2F6DB5", PORTTAVLAN);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const css = buildAccentOverrideStylesheet(result.override);

    expect(css).toContain(":root {");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--obrf-accent-trust:");
    expect(css).toContain("--obrf-accent-trust-register:");
  });

  it("states only accent tokens, so the rest keeps coming from the theme", () => {
    const result = primaryColorOverride("#2F6DB5", PORTTAVLAN);
    if (!result.ok) {
      expect(result.ok).toBe(true);
      return;
    }

    const css = buildAccentOverrideStylesheet(result.override);

    expect(css).not.toContain("--obrf-surface-page:");
    expect(css).not.toContain("--obrf-text-register:");
  });

  it("gives the dark block the dark values", () => {
    const result = primaryColorOverride("#7D5F23", PORTTAVLAN);
    if (!result.ok) {
      expect(result.ok).toBe(true);
      return;
    }

    const css = buildAccentOverrideStylesheet(result.override);
    const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));

    expect(darkBlock).toContain(result.override.dark["accent-trust"]);
    expect(darkBlock).not.toContain(result.override.light["accent-trust"]);
  });
});

describe("normalizeColor", () => {
  it("canonicalises every accepted notation to lowercase hex", () => {
    expect(normalizeColor("#7D5F23")).toBe("#7d5f23");
    expect(normalizeColor("rgb(125, 95, 35)")).toBe("#7d5f23");
    expect(normalizeColor("#abc")).toBe("#aabbcc");
  });

  it("returns null rather than a guess for anything else", () => {
    expect(normalizeColor("brass")).toBeNull();
    expect(normalizeColor("#7d5f2")).toBeNull();
  });
});

import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { describe, expect, it } from "vitest";

import type { ThemeRendering } from "../api/themes";
import {
  builtInRendering,
  COLOUR_TOKEN_NAMES,
  composerGroups,
  draftFindings,
  draftRendering,
  DRAFT_THEME_ID,
  pruneOverrides,
} from "./composer-draft";

/**
 * The draft a theme is composed from.
 *
 * Two things are load-bearing. A composed theme states only what it changes, so
 * a value equal to the one it would inherit has to be pruned before it reaches
 * the manifest - otherwise opening the form and saving it turns a child theme
 * into a full copy of its parent, and the copy stops following its parent the
 * next time somebody changes it. And the preview has to be what the server will
 * build, or a board approves one theme and activates another.
 */

const PARENT: ThemeRendering = {
  id: "porttavlan",
  name: "Porttavlan",
  builtIn: true,
  modes: { light: { ...PORTTAVLAN_LIGHT }, dark: { ...PORTTAVLAN_DARK } },
  fontFaces: [
    {
      family: "Spline Sans Mono",
      weight: "400",
      style: "normal",
      url: "/api/themes/asset?theme=example-theme&file=fonts/x.woff2",
      format: "woff2",
    },
  ],
  viewVariants: { memberRegister: "table" },
  logoUrl: "/api/themes/asset?theme=example-theme&file=logo.png",
};

describe("which tokens the composer offers", () => {
  /*
   * Selected by what the default theme's value IS rather than by name, so a
   * colour added to a later contract appears without this list being edited.
   */
  it("offers the colours and nothing else", () => {
    expect(COLOUR_TOKEN_NAMES).toContain("surface-page");
    expect(COLOUR_TOKEN_NAMES).toContain("status-warn-register");
    expect(COLOUR_TOKEN_NAMES).not.toContain("radius-control");
    expect(COLOUR_TOKEN_NAMES).not.toContain("shadow-raised");
    expect(COLOUR_TOKEN_NAMES).not.toContain("motion-duration");
    expect(COLOUR_TOKEN_NAMES).not.toContain("font-data");
  });

  it("places every offered colour in exactly one group", () => {
    const groups = composerGroups();
    const placed = groups.flatMap((group) => group.tokens);

    expect([...placed].sort()).toEqual([...COLOUR_TOKEN_NAMES].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  /*
   * The register family first among the matches: surface-register is a
   * register colour before it is a surface, and the statutory pairs belong
   * together rather than scattered across three sections of the form.
   */
  it("keeps the statutory register's colours together", () => {
    const register = composerGroups().find(
      (group) => group.name === "register",
    );

    expect(register?.tokens).toContain("surface-register");
    expect(register?.tokens).toContain("text-register");
    expect(register?.tokens).toContain("accent-trust-register");
    expect(register?.tokens).toContain("status-warn-register");

    const surfaces = composerGroups().find(
      (group) => group.name === "surfaces",
    );
    expect(surfaces?.tokens).not.toContain("surface-register");
  });
});

describe("what a draft really states", () => {
  it("drops a value equal to the one it would inherit", () => {
    const pruned = pruneOverrides(PARENT.modes.light, {
      "surface-page": PORTTAVLAN_LIGHT["surface-page"],
      "accent-trust": "#2F5D50",
    });

    expect(pruned).toEqual({ "accent-trust": "#2F5D50" });
  });

  /*
   * The colour input writes the lowercase form of a value the default theme
   * states in uppercase. Comparing the text rather than the colour would record
   * every field the board merely looked at as an override.
   */
  it("compares colours as colours, not as text", () => {
    expect(
      pruneOverrides(PARENT.modes.light, { "surface-page": "#efede7" }),
    ).toEqual({});
    expect(
      pruneOverrides(PARENT.modes.light, { "surface-page": "#EFE" }),
    ).toEqual({ "surface-page": "#EFE" });
  });

  it("drops an empty field rather than storing an empty value", () => {
    expect(
      pruneOverrides(PARENT.modes.light, {
        "accent-trust": "  ",
        "surface-raised": "",
      }),
    ).toEqual({});
  });
});

describe("what the draft renders as", () => {
  it("lays the overrides over the parent's resolved values", () => {
    const rendering = draftRendering(PARENT, {
      displayName: "Husets farger",
      modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
    });

    expect(rendering.id).toBe(DRAFT_THEME_ID);
    expect(rendering.name).toBe("Husets farger");
    expect(rendering.builtIn).toBe(false);
    expect(rendering.modes.light["accent-trust"]).toBe("#2F5D50");
    expect(rendering.modes.light["surface-page"]).toBe(
      PORTTAVLAN_LIGHT["surface-page"],
    );
    expect(rendering.modes.dark["accent-trust"]).toBe(
      PORTTAVLAN_DARK["accent-trust"],
    );
  });

  /*
   * A composed manifest bundles no fonts and selects no layout, and both are
   * read from a theme's own row rather than resolved along the inheritance
   * chain. A preview carrying the parent's would show a board something the
   * saved theme will not do.
   */
  it("does not inherit the parent's typefaces, layout or logo", () => {
    const rendering = draftRendering(PARENT, {
      displayName: "",
      modes: { light: {}, dark: {} },
    });

    expect(rendering.fontFaces).toEqual([]);
    expect(rendering.viewVariants).toEqual({});
    expect(rendering.logoUrl).toBeNull();
    // With no name of its own yet, the draft is named after its parent.
    expect(rendering.name).toBe("Porttavlan");
  });
});

describe("the contrast measured while composing", () => {
  it("says nothing about a draft that meets the bar", () => {
    const rendering = draftRendering(PARENT, {
      displayName: "Husets farger",
      modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
    });

    expect(draftFindings(rendering)).toEqual([]);
  });

  /*
   * The shape a refusal travels in, so one component renders both the advice
   * and the server's own refusal. The register pairs carry the flag that makes
   * the sentence say why they are refused rather than reported.
   */
  it("names a statutory pair in the shape a refusal arrives in", () => {
    const rendering = draftRendering(PARENT, {
      displayName: "Olasligt",
      modes: { light: { "text-register": "#4D4D4D" }, dark: {} },
    });

    const finding = draftFindings(rendering).find(
      (candidate) =>
        candidate.detail["foreground"] === "text-register" &&
        candidate.detail["background"] === "surface-register",
    );

    expect(finding?.rule).toBe("contrast");
    expect(finding?.severity).toBe("error");
    expect(finding?.detail["mode"]).toBe("light");
    expect(finding?.detail["statutory"]).toBe(true);
    expect(finding?.detail["required"]).toBe(4.5);
    expect(Number(finding?.detail["ratio"])).toBeLessThan(4.5);
  });

  it("reports a colour it cannot read at all as an unmeasurable pair", () => {
    const rendering = draftRendering(PARENT, {
      displayName: "Genomskinligt",
      modes: {
        light: { "text-register": "rgba(255, 255, 255, 0.2)" },
        dark: {},
      },
    });

    const finding = draftFindings(rendering).find(
      (candidate) => candidate.detail["foreground"] === "text-register",
    );
    expect(finding?.detail["ratio"]).toBe(-1);
  });
});

describe("the default theme as a parent", () => {
  it("is built from the values that ship with the application", () => {
    const rendering = builtInRendering();

    expect(rendering.id).toBe("porttavlan");
    expect(rendering.builtIn).toBe(true);
    expect(rendering.modes.light["surface-register"]).toBe(
      PORTTAVLAN_LIGHT["surface-register"],
    );
    expect(rendering.modes.dark["surface-register"]).toBe(
      PORTTAVLAN_DARK["surface-register"],
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  AA_CONTRAST_RATIO,
  checkContrast,
  contrastRatio,
  parseColor,
  relativeLuminance,
} from "./contrast.ts";
import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "./porttavlan.ts";

describe("parseColor", () => {
  it.each([
    ["#fff", { r: 255, g: 255, b: 255 }],
    ["#FFFFFF", { r: 255, g: 255, b: 255 }],
    ["#000000", { r: 0, g: 0, b: 0 }],
    ["#8A6D28", { r: 138, g: 109, b: 40 }],
    ["#8A6D28FF", { r: 138, g: 109, b: 40 }],
    ["rgb(138, 109, 40)", { r: 138, g: 109, b: 40 }],
    ["rgba(138, 109, 40, 0.5)", { r: 138, g: 109, b: 40 }],
  ])("parses %s", (input, expected) => {
    expect(parseColor(input)).toEqual(expected);
  });

  it.each(["", "not-a-color", "#12345", "var(--something)"])(
    "returns null for %s rather than guessing",
    (input) => {
      expect(parseColor(input)).toBeNull();
    },
  );
});

describe("contrastRatio", () => {
  it("computes the known extremes", () => {
    // Black on white is the maximum possible ratio.
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    const a = contrastRatio("#26272A", "#EFEDE7");
    const b = contrastRatio("#EFEDE7", "#26272A");
    expect(a).toBeCloseTo(b ?? 0, 10);
  });

  it("returns null when a colour cannot be parsed", () => {
    // A theme with an unreadable value must fail, not silently pass.
    expect(contrastRatio("nonsense", "#FFFFFF")).toBeNull();
  });

  it("matches WCAG reference luminance for white and black", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
  });
});

/**
 * The default theme must pass its own gate. If this fails, either the palette
 * in DESIGN.md is not AA compliant or the pair list is wrong, and both are
 * worth knowing immediately.
 */
describe("the default theme meets AA", () => {
  it("passes every pair in light mode", () => {
    const findings = checkContrast(PORTTAVLAN_LIGHT);
    expect(
      findings.map(
        (f) =>
          `${f.foreground} on ${f.background}: ${String(f.ratio?.toFixed(2) ?? "unparseable")}`,
      ),
    ).toEqual([]);
  });

  it("passes every pair in dark mode", () => {
    const findings = checkContrast(PORTTAVLAN_DARK);
    expect(
      findings.map(
        (f) =>
          `${f.foreground} on ${f.background}: ${String(f.ratio?.toFixed(2) ?? "unparseable")}`,
      ),
    ).toEqual([]);
  });

  it("holds the register text well clear of the minimum", () => {
    // The register is a statutory document read by people of every age, so the
    // primary pair should have real headroom rather than scraping past 4.5.
    const ratio = contrastRatio(
      PORTTAVLAN_LIGHT["text-register"],
      PORTTAVLAN_LIGHT["surface-register"],
    );
    expect(ratio).toBeGreaterThan(10);
  });
});

describe("checkContrast", () => {
  it("flags a statutory failure distinctly from a room-side one", () => {
    const broken = {
      ...PORTTAVLAN_LIGHT,
      // Near-invisible register text: exactly what the gate exists to stop.
      "text-register": "#1D1E20",
    };

    const findings = checkContrast(broken);
    const registerFinding = findings.find(
      (f) =>
        f.foreground === "text-register" && f.background === "surface-register",
    );

    expect(registerFinding).toBeDefined();
    expect(registerFinding?.statutory).toBe(true);
    expect(registerFinding?.required).toBe(AA_CONTRAST_RATIO);
  });

  it("treats an unparseable colour as a failure", () => {
    const broken = { ...PORTTAVLAN_LIGHT, "text-primary": "chartreuse-ish" };
    const findings = checkContrast(broken);
    expect(findings.some((f) => f.ratio === null)).toBe(true);
  });
});

import { type TokenName, type TokenSet } from "./contract.ts";
import {
  AA_CONTRAST_RATIO,
  checkContrast,
  type ContrastFinding,
  contrastRatio,
  parseColor,
} from "./contrast.ts";
import type { ThemeModes } from "./porttavlan.ts";
import { tokensToCssDeclarations } from "./resolve.ts";

/**
 * Per-association branding: one chosen colour, the whole trust accent family.
 *
 * An association on the free tier may set its own primary colour (decision
 * 40), and the trust accent is the only colour it reaches. That accent is not
 * one value: it appears as link and sign colour in the room, as a hover state,
 * as a tinted background, as text ON the register surface, and as the ground
 * under light lettering. Asking a board to pick all five by eye would guarantee
 * an illegible statutory register, so four are derived from the fifth here and
 * the result is measured before it can be saved.
 *
 * This module adds NO token names. It produces values for accent tokens the
 * contract already defines, so it is not a contract change and needs no
 * version bump.
 *
 * Both derivation directions come out of one rule: mix towards the mode's own
 * ink. In the light mode the ink is dark, so a colour too pale to read gets
 * darkened; in the dark mode the ink is light, so a colour too dark to read
 * gets lightened. That is what the default theme already does by hand, where
 * the same brass is #7D5F23 in the light mode and #C9A64B in the dark one.
 */

/** The accent tokens this module produces values for. */
export const ACCENT_TOKEN_NAMES = [
  "accent-trust",
  "accent-trust-hover",
  "accent-trust-soft",
  "accent-trust-register",
  "on-accent-trust",
] as const satisfies readonly TokenName[];

export type AccentTokenName = (typeof ACCENT_TOKEN_NAMES)[number];

/** Values for the five accent tokens, for one mode. */
export type AccentFamily = Record<AccentTokenName, string>;

/** The derived override: one family per mode. */
export interface AccentOverride {
  light: AccentFamily;
  dark: AccentFamily;
}

/** How far the hover state moves towards the ink. */
const HOVER_MIX = 0.15;
/** How much surface a soft tint is: mostly surface, a hint of accent. */
const SOFT_SURFACE_MIX = 0.88;
/** Step of the search that pushes a colour towards legibility. */
const SEARCH_STEP = 0.05;

/**
 * How far a chosen colour may be moved towards the ink before it is refused.
 *
 * Some bound is necessary. Mixing towards the mode's ink always reaches AA
 * eventually - keep going and any colour ends up as the ink itself - so an
 * unbounded search would accept every value and quietly render something the
 * board never chose. Past roughly six parts in ten the result is no longer
 * recognisably their colour, so the honest answer is that it cannot serve as
 * the accent.
 */
export const MAX_INK_MIX = 0.6;

/** Which surface family a colour could not be made to read on. */
export type AccentSurface = "room" | "register";

export type AccentDerivation =
  { ok: true; family: AccentFamily } | { ok: false; surface: AccentSurface };

export type BrandingProblem =
  /** The value is not a colour this code can read at all. */
  | { reason: "unreadable-colour" }
  /**
   * The colour cannot be made to meet AA on a surface it has to be read on.
   * Carries the measured pairs so the screen can name them.
   */
  | { reason: "fails-contrast"; findings: readonly ContrastFinding[] };

export type BrandingResult =
  | { ok: true; override: AccentOverride }
  | { ok: false; problem: BrandingProblem };

/** Mixes two colours in sRGB. `weight` is how much of `towards` to take. */
export function mixColors(
  from: string,
  towards: string,
  weight: number,
): string | null {
  const a = parseColor(from);
  const b = parseColor(towards);
  if (a === null || b === null) {
    return null;
  }

  const clamped = Math.min(Math.max(weight, 0), 1);
  const channel = (x: number, y: number): number =>
    Math.round(x + (y - x) * clamped);

  return toHex({
    r: channel(a.r, b.r),
    g: channel(a.g, b.g),
    b: channel(a.b, b.b),
  });
}

/**
 * The canonical form of a colour: lowercase six-digit hex.
 *
 * Stored rather than the value as typed, so "#7D5F23", "#7d5f23" and
 * "rgb(125, 95, 35)" are one colour in the database instead of three.
 */
export function normalizeColor(value: string): string | null {
  const parsed = parseColor(value);
  return parsed === null ? null : toHex(parsed);
}

function toHex(color: { r: number; g: number; b: number }): string {
  const pair = (value: number): string =>
    Math.min(Math.max(Math.round(value), 0), 255)
      .toString(16)
      .padStart(2, "0");
  return `#${pair(color.r)}${pair(color.g)}${pair(color.b)}`;
}

/**
 * The nearest mix of `color` towards `ink` that meets AA against every one of
 * `backgrounds`, or null when no mix within `maxMix` does.
 *
 * A stepped search rather than a formula, because the target is a ratio against
 * several backgrounds at once and the smallest step that satisfies all of them
 * is the one that stays closest to the colour the board actually chose.
 */
export function pushToContrast(
  color: string,
  ink: string,
  backgrounds: readonly string[],
  maxMix: number = MAX_INK_MIX,
): string | null {
  // Rounded, not floored: 0.6 / 0.05 is 11.999... in binary floating point, and
  // flooring it would silently drop the last step and refuse colours the bound
  // is meant to allow.
  const steps = Math.round(maxMix / SEARCH_STEP);

  for (let step = 0; step <= steps; step++) {
    const candidate = mixColors(color, ink, step * SEARCH_STEP);
    if (candidate === null) {
      return null;
    }
    const passes = backgrounds.every((background) => {
      const ratio = contrastRatio(candidate, background);
      return ratio !== null && ratio >= AA_CONTRAST_RATIO;
    });
    if (passes) {
      return candidate;
    }
  }
  return null;
}

/**
 * Derives the accent family for one mode from the association's colour.
 *
 * The register variant is derived from the chosen colour rather than from the
 * already-adjusted room accent: the register is a different ground, and
 * chaining one adjustment onto another drifts further from the board's colour
 * than it needs to.
 *
 * Reports WHICH surface family defeated the colour, because the two mean
 * different things to a board: failing in the room is a branding problem, and
 * failing on the register is a statutory one.
 */
export function deriveAccentFamily(
  primaryColor: string,
  base: TokenSet,
): AccentDerivation {
  const ink = base["text-primary"];

  const accent = pushToContrast(primaryColor, ink, [
    base["surface-page"],
    base["surface-raised"],
  ]);
  if (accent === null) {
    return { ok: false, surface: "room" };
  }

  const register = pushToContrast(primaryColor, base["text-register"], [
    base["surface-register"],
    base["surface-register-raised"],
  ]);
  if (register === null) {
    return { ok: false, surface: "register" };
  }

  const hover = mixColors(accent, ink, HOVER_MIX);
  const soft = mixColors(accent, base["surface-raised"], SOFT_SURFACE_MIX);
  if (hover === null || soft === null) {
    return { ok: false, surface: "room" };
  }

  return {
    ok: true,
    family: {
      "accent-trust": accent,
      "accent-trust-hover": hover,
      "accent-trust-soft": soft,
      "accent-trust-register": register,
      "on-accent-trust": readableOn(accent, [
        base["on-accent-trust"],
        base["text-primary"],
      ]),
    },
  };
}

/**
 * The candidate that reads best on `ground`.
 *
 * Candidates come from the theme's own palette rather than from a hardcoded
 * white and black, so an override never introduces a colour the theme does not
 * already contain.
 */
function readableOn(ground: string, candidates: readonly string[]): string {
  let best = candidates[0] ?? ground;
  let bestRatio = -1;

  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, ground) ?? -1;
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }

  return best;
}

/**
 * Derives the override for both modes and then MEASURES it.
 *
 * The measurement is the point. It runs the contract's whole contrast matrix
 * against the overridden token set rather than only the pairs the derivation
 * touched, because an accent that reads on its own can still break a pair it
 * appears in, and the register pairs are statutory: an association has to be
 * able to read the register the law requires it to keep.
 *
 * Failures come back rather than being thrown, so the settings screen can name
 * the pair and the ratio instead of saying "invalid colour".
 */
export function primaryColorOverride(
  primaryColor: string,
  modes: ThemeModes,
): BrandingResult {
  if (normalizeColor(primaryColor) === null) {
    return { ok: false, problem: { reason: "unreadable-colour" } };
  }

  const findings: ContrastFinding[] = [];
  const derived: Partial<Record<keyof ThemeModes, AccentFamily>> = {};

  for (const mode of ["light", "dark"] as const) {
    const base = modes[mode];
    const derivation = deriveAccentFamily(primaryColor, base);

    if (!derivation.ok) {
      findings.push(blockedFinding(primaryColor, base, derivation.surface));
      continue;
    }

    derived[mode] = derivation.family;
    findings.push(...checkContrast({ ...base, ...derivation.family }));
  }

  if (
    findings.length > 0 ||
    derived.light === undefined ||
    derived.dark === undefined
  ) {
    return { ok: false, problem: { reason: "fails-contrast", findings } };
  }

  return { ok: true, override: { light: derived.light, dark: derived.dark } };
}

/**
 * The measured pair to report when no mix reached AA.
 *
 * It states the chosen colour against the surface that defeated it, which is
 * the number a board can act on: "your colour measures 1.1 to 1 against the
 * page" says what "invalid colour" never would.
 */
function blockedFinding(
  primaryColor: string,
  base: TokenSet,
  surface: AccentSurface,
): ContrastFinding {
  const background: TokenName =
    surface === "register" ? "surface-register" : "surface-page";

  return {
    foreground:
      surface === "register" ? "accent-trust-register" : "accent-trust",
    background,
    ratio: contrastRatio(primaryColor, base[background]),
    required: AA_CONTRAST_RATIO,
    // The register is the statutory surface: a colour that cannot be read there
    // would make a legally required document illegible.
    statutory: surface === "register",
  };
}

/**
 * The override as a stylesheet, for the running application to inject.
 *
 * Three blocks in the same shape as the generated default stylesheet, so an
 * explicit light or dark choice still wins over the system preference. Only the
 * accent tokens appear, so everything else keeps coming from the active theme.
 */
export function buildAccentOverrideStylesheet(
  override: AccentOverride,
): string {
  return [
    ":root {",
    tokensToCssDeclarations(override.light),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    '  :root:not([data-theme="light"]) {',
    indentBlock(tokensToCssDeclarations(override.dark)),
    "  }",
    "}",
    "",
    ':root[data-theme="dark"] {',
    tokensToCssDeclarations(override.dark),
    "}",
    "",
  ].join("\n");
}

function indentBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

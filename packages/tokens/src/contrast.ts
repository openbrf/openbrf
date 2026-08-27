import { CONTRAST_PAIRS, type TokenName, type TokenSet } from "./contract.ts";

/**
 * WCAG contrast, used to gate theme installation.
 *
 * A theme that fails a statutory pair is refused rather than warned about: the
 * member and apartment registers are documents an association is legally
 * required to be able to produce and read, so a theme must not be able to make
 * them illegible (decision 45).
 */

/** WCAG AA for body text, and the bar this project holds even at 13px. */
export const AA_CONTRAST_RATIO = 4.5;

/**
 * Parses a colour to sRGB components in 0-255.
 *
 * Accepts hex in 3, 4, 6 and 8 digit forms and rgb()/rgba() notation, which
 * covers what a theme author realistically writes. Anything else returns null
 * so the caller reports it instead of computing nonsense.
 *
 * A colour that is not fully opaque also returns null. Discarding the alpha
 * channel would let a transparent colour pass the contrast gate on the
 * strength of RGB values nobody ever sees: #F4F2EC00 measures 15.07:1 against
 * the dark surface it is invisible on. What such a colour actually contrasts
 * with depends on whatever is painted behind it, which is not known here, so
 * the honest answer is to refuse it rather than to guess a backdrop.
 */
export function parseColor(
  value: string,
): { r: number; g: number; b: number } | null {
  const input = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(input);
  if (hex?.[1] !== undefined) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = [digits[0], digits[1], digits[2]];
      if (r === undefined || g === undefined || b === undefined) {
        return null;
      }
      if (digits.length === 4 && digits[3] !== "f") {
        return null;
      }
      return {
        r: Number.parseInt(`${r}${r}`, 16),
        g: Number.parseInt(`${g}${g}`, 16),
        b: Number.parseInt(`${b}${b}`, 16),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      if (digits.length === 8 && digits.slice(6, 8) !== "ff") {
        return null;
      }
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
      };
    }
    return null;
  }

  const rgb =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(
      input,
    );
  if (rgb?.[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined) {
    if (rgb[4] !== undefined && !isFullyOpaque(rgb[4])) {
      return null;
    }
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
    };
  }

  return null;
}

/** True for the alpha values CSS treats as fully opaque: 1 and 100%. */
function isFullyOpaque(alpha: string): boolean {
  const numeric = alpha.endsWith("%")
    ? Number(alpha.slice(0, -1)) / 100
    : Number(alpha);
  return numeric === 1;
}

/** Relative luminance per WCAG 2.1. */
export function relativeLuminance(color: {
  r: number;
  g: number;
  b: number;
}): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(color.r) +
    0.7152 * channel(color.g) +
    0.0722 * channel(color.b)
  );
}

/**
 * Contrast ratio between two colours, from 1 to 21.
 *
 * Returns null when either colour cannot be parsed, which the caller must treat
 * as a failure rather than a pass.
 */
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (fg === null || bg === null) {
    return null;
  }

  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastFinding {
  foreground: TokenName;
  background: TokenName;
  /** Null when a colour could not be parsed. */
  ratio: number | null;
  required: number;
  /** A statutory failure blocks installation; others are reported. */
  statutory: boolean;
}

/**
 * Checks every contract pair against a resolved token set.
 *
 * Returns only the failures, so an empty array means the mode is compliant.
 */
export function checkContrast(tokens: TokenSet): ContrastFinding[] {
  const findings: ContrastFinding[] = [];

  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrastRatio(
      tokens[pair.foreground],
      tokens[pair.background],
    );

    if (ratio === null || ratio < AA_CONTRAST_RATIO) {
      findings.push({
        foreground: pair.foreground,
        background: pair.background,
        ratio,
        required: AA_CONTRAST_RATIO,
        statutory: pair.statutory,
      });
    }
  }

  return findings;
}

import type { ThemeFontDeclaration } from "./manifest.ts";

/**
 * The @font-face rules for a theme's bundled fonts.
 *
 * Built here rather than in either the API or the browser so both sides agree
 * on what a font declaration means, and so the escaping below exists once. A
 * family name comes from a third-party manifest and lands inside a CSS string,
 * where an unescaped quote would end the string and let the rest of the value
 * write rules of its own.
 *
 * Every source is a path inside the theme package, turned into a URL by the
 * caller, which is what keeps the promise the lint enforces: a theme's fonts
 * are served from the association's own instance and never fetched from a third
 * party.
 */

const FORMAT_BY_EXTENSION: Readonly<Record<string, string>> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

/** The two styles a declaration may name. */
const FONT_STYLES = new Set(["normal", "italic"]);

/** A single CSS weight, or a variable font's range. */
const FONT_WEIGHT_PATTERN = /^\d{3}(?: \d{3})?$/;

/*
 * Style and weight are the only two fields that reach a declaration unquoted,
 * so they are the only two an unchecked value could write rules through. The
 * manifest schema constrains both, but a face can also arrive from a stored
 * row or over the network, and a boundary that writes CSS checks its own input
 * rather than trusting that an earlier one did.
 *
 * A value outside the contract falls back rather than throwing: this runs while
 * a page is rendering, and one malformed face is not a reason to leave the
 * interface with no typefaces at all.
 */

/** The declared style, or upright when it is not one a declaration may name. */
export function cssFontStyle(value: string): string {
  return FONT_STYLES.has(value) ? value : "normal";
}

/** The declared weight, or regular when it is not a weight CSS can read. */
export function cssFontWeight(value: string): string {
  return FONT_WEIGHT_PATTERN.test(value) ? value : "400";
}

/** A CSS string literal. Refuses what it cannot represent rather than mangling it. */
export function cssString(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error("A CSS string may not contain a control character.");
    }
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface ThemeFontFaceSource {
  family: string;
  weight: string;
  style: string;
  url: string;
  /** The CSS format() hint, or null for an extension with no hint. */
  format: string | null;
}

/** Flattens a theme's declarations into one face per file. */
export function themeFontFaces(
  fonts: readonly ThemeFontDeclaration[],
  urlFor: (path: string) => string,
): ThemeFontFaceSource[] {
  return fonts.flatMap((font) =>
    font.files.map((file) => {
      const extension = file.path.slice(file.path.lastIndexOf(".") + 1);
      return {
        family: font.family,
        weight: file.weight,
        style: file.style,
        url: urlFor(file.path),
        format: FORMAT_BY_EXTENSION[extension.toLowerCase()] ?? null,
      };
    }),
  );
}

/**
 * Renders the faces as CSS.
 *
 * `font-display: swap` so text is readable while the face loads: the register
 * is a document, and an invisible column of names is worse than one drawn in a
 * fallback face for a moment.
 */
export function buildFontFaceStylesheet(
  faces: readonly ThemeFontFaceSource[],
): string {
  return faces
    .map((face) => {
      const source =
        face.format === null
          ? `url(${cssString(face.url)})`
          : `url(${cssString(face.url)}) format(${cssString(face.format)})`;
      return [
        "@font-face {",
        `  font-family: ${cssString(face.family)};`,
        `  font-style: ${cssFontStyle(face.style)};`,
        `  font-weight: ${cssFontWeight(face.weight)};`,
        "  font-display: swap;",
        `  src: ${source};`,
        "}",
      ].join("\n");
    })
    .join("\n\n");
}

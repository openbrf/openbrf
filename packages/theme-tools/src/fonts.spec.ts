import { describe, expect, it } from "vitest";

import { buildFontFaceStylesheet, cssString, themeFontFaces } from "./fonts.ts";
import { parseThemeManifest } from "./manifest.ts";

/**
 * A family name comes from a third-party manifest and lands inside a CSS
 * string. An unescaped quote there ends the string and lets the rest of the
 * value write rules of its own, which is why the escaping is tested rather than
 * assumed.
 */

function fontsOf(fonts: unknown) {
  const parsed = parseThemeManifest(
    JSON.stringify({
      name: "example-theme",
      displayName: "Example",
      version: "1.0.0",
      contract: "^1.0.0",
      fonts,
    }),
  );
  if (!parsed.ok) {
    throw new Error(parsed.issues.join(", "));
  }
  return parsed.manifest.fonts;
}

describe("themeFontFaces", () => {
  it("produces one face per file, with the format hint the extension implies", () => {
    const faces = themeFontFaces(
      fontsOf([
        {
          family: "Inter",
          license: "OFL-1.1",
          files: [
            { path: "fonts/inter-400.woff2", weight: "400" },
            { path: "fonts/inter-700.woff2", weight: "700", style: "italic" },
          ],
        },
      ]),
      (path) => `/api/themes/asset?theme=example-theme&file=${path}`,
    );

    expect(faces).toEqual([
      {
        family: "Inter",
        weight: "400",
        style: "normal",
        url: "/api/themes/asset?theme=example-theme&file=fonts/inter-400.woff2",
        format: "woff2",
      },
      {
        family: "Inter",
        weight: "700",
        style: "italic",
        url: "/api/themes/asset?theme=example-theme&file=fonts/inter-700.woff2",
        format: "woff2",
      },
    ]);
  });
});

describe("buildFontFaceStylesheet", () => {
  it("renders a face the browser can load", () => {
    const css = buildFontFaceStylesheet([
      {
        family: "Inter",
        weight: "400",
        style: "normal",
        url: "/fonts/inter.woff2",
        format: "woff2",
      },
    ]);

    expect(css).toContain('font-family: "Inter";');
    expect(css).toContain('src: url("/fonts/inter.woff2") format("woff2");');
    expect(css).toContain("font-display: swap;");
  });

  it("escapes a family name that would otherwise close the string", () => {
    const css = buildFontFaceStylesheet([
      {
        family:
          'Evil"; } :root { --obrf-text-register: #111; } @font-face { font-family: "x',
        weight: "400",
        style: "normal",
        url: "/fonts/x.woff2",
        format: "woff2",
      },
    ]);

    // The quote is escaped, so the string never closes and the register token
    // below it stays inert text rather than becoming a declaration.
    expect(css).toContain('Evil\\"; }');
    expect(css).not.toContain('Evil"; }');
  });

  /*
   * Style and weight are the only two fields that reach a declaration unquoted.
   * The manifest schema constrains both, but a face also arrives here from a
   * stored row and over the network, and a boundary that writes CSS checks its
   * own input rather than trusting that an earlier one did.
   */
  it("writes no rule a weight or style asked it to", () => {
    const css = buildFontFaceStylesheet([
      {
        family: "Inter",
        weight: "400; } :root { --obrf-text-register: #111; } @font-face { ",
        style: "normal; } :root { --obrf-surface-register: #111; ",
        url: "/fonts/inter.woff2",
        format: "woff2",
      },
    ]);

    expect(css).not.toContain("--obrf-text-register");
    expect(css).not.toContain("--obrf-surface-register");
    // The face still renders, in the upright regular the contract's defaults
    // name: one malformed declaration is not a reason to drop the typeface.
    expect(css).toContain("font-weight: 400;");
    expect(css).toContain("font-style: normal;");
  });

  it("keeps a weight and style the contract does allow", () => {
    const css = buildFontFaceStylesheet([
      {
        family: "Inter",
        weight: "100 900",
        style: "italic",
        url: "/fonts/inter.woff2",
        format: "woff2",
      },
    ]);

    expect(css).toContain("font-weight: 100 900;");
    expect(css).toContain("font-style: italic;");
  });
});

describe("cssString", () => {
  it("refuses a control character rather than emitting it", () => {
    expect(() => cssString("Inter\n")).toThrow(/control character/);
  });
});

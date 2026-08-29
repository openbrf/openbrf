import { describe, expect, it } from "vitest";

import { ThemeService, type ThemeRendering } from "../themes/theme.service";
import { buildSiteStylesheet } from "./site-css";

/**
 * The website is styled entirely by the theme the association installed, and it
 * is styled on the server because the page runs no JavaScript. What that costs
 * is that the three things the browser normally assembles - the token values,
 * the typefaces and the association's accent - have to be assembled here, in
 * that order, or an explicit dark choice stops winning over the system one.
 */

const BUILT_IN = ThemeService.builtInRendering();

const INSTALLED: ThemeRendering = {
  ...BUILT_IN,
  id: "brf-teal",
  name: "Teal",
  builtIn: false,
  fontFaces: [
    {
      family: "Some Face",
      style: "normal",
      weight: "400",
      url: "/api/themes/asset?theme=brf-teal&file=fonts/a.woff2",
      format: "woff2",
    },
  ],
};

describe("the website's stylesheet", () => {
  it("writes the theme's values three times over", () => {
    const css = buildSiteStylesheet({
      rendering: BUILT_IN,
      primaryColor: null,
    });

    // Light on :root, dark under the system preference, dark again under an
    // explicit choice. A value defined only inside the media query would be
    // unreachable for a visitor who chose a mode.
    expect(css).toContain(":root {");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--obrf-surface-page:");
  });

  it("declares the default typefaces from this instance", () => {
    const css = buildSiteStylesheet({
      rendering: BUILT_IN,
      primaryColor: null,
    });

    expect(css).toContain("@font-face");
    expect(css).toContain('url("/fonts/familjen-grotesk-latin.woff2")');
    expect(css).toContain('url("/fonts/spline-sans-mono-latin.woff2")');
  });

  it("declares an installed theme's typefaces instead", () => {
    const css = buildSiteStylesheet({
      rendering: INSTALLED,
      primaryColor: null,
    });

    expect(css).toContain("/api/themes/asset?theme=brf-teal");
    expect(css).not.toContain("/fonts/familjen-grotesk-latin.woff2");
  });

  it("names no host but this one", () => {
    for (const rendering of [BUILT_IN, INSTALLED]) {
      const css = buildSiteStylesheet({ rendering, primaryColor: "#2F6DB5" });
      // A stylesheet is the easiest place to smuggle a request to a third
      // party - a font, a background image, an @import. There is no legitimate
      // reason for one to appear here.
      expect(css).not.toContain("http://");
      expect(css).not.toContain("https://");
      expect(css).not.toContain("//");
      expect(css).not.toContain("@import");
    }
  });

  it("lays the page out in tokens and nothing else", () => {
    const css = buildSiteStylesheet({
      rendering: BUILT_IN,
      primaryColor: null,
    });
    const layout = css.slice(css.indexOf("*, *::before"));

    // Not one literal colour below the token blocks: a theme the board installs
    // restyles the website by the same act that restyles the interface.
    expect(layout).toContain("var(--obrf-surface-page)");
    expect(layout).toContain("var(--obrf-border-subtle)");
    expect(/#[0-9a-f]{3,8}\b/i.test(layout)).toBe(false);
  });

  it("folds a dropdown away without putting it out of reach", () => {
    const css = buildSiteStylesheet({
      rendering: BUILT_IN,
      primaryColor: null,
    });

    /*
     * The two halves of the disclosure, asserted as a pair because they are
     * only correct together. Hiding the second level is what makes it a
     * dropdown; revealing it on focus as well as on hover is what keeps it
     * reachable by somebody with no pointer. Delete the focus half and the
     * menu still looks right and still works with a mouse, which is exactly
     * the kind of regression nobody notices.
     */
    expect(css).toContain(".site-nav-group .site-nav-children");
    expect(css).toContain(".site-nav-group:hover > .site-nav-children");
    expect(css).toContain(".site-nav-group:focus-within > .site-nav-children");
  });

  it("adds the association's accent last, so it wins", () => {
    const withAccent = buildSiteStylesheet({
      rendering: BUILT_IN,
      primaryColor: "#2F6DB5",
    });
    const without = buildSiteStylesheet({
      rendering: BUILT_IN,
      primaryColor: null,
    });

    expect(withAccent.length).toBeGreaterThan(without.length);
    expect(withAccent.startsWith(without)).toBe(true);
    expect(withAccent.slice(without.length)).toContain("--obrf-accent-trust:");
  });

  it("ignores a colour the contrast matrix refuses", () => {
    // The settings screen refuses to store one, so this is the second line.
    // Keeping the theme's own legible accent is the right failure: an
    // association has to be able to read its own website.
    const css = buildSiteStylesheet({
      rendering: BUILT_IN,
      primaryColor: "not a colour",
    });

    expect(css).toBe(
      buildSiteStylesheet({ rendering: BUILT_IN, primaryColor: null }),
    );
  });

  it("cannot close the element it is written into", () => {
    // The stylesheet goes into a <style>, which HTML parses as raw text: the
    // element ends at the first "</style" and nothing before it is escaped. A
    // token value or a theme's font path is a database column, so this is the
    // last point that can hold the "no script" property.
    const hostile: ThemeRendering = {
      ...BUILT_IN,
      builtIn: false,
      fontFaces: [
        {
          family: "X</style><script>alert(1)</script>",
          style: "normal",
          weight: "400",
          url: "/a.woff2",
          format: "woff2",
        },
      ],
    };

    const css = buildSiteStylesheet({ rendering: hostile, primaryColor: null });

    expect(css).not.toContain("<");
  });
});

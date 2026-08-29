import {
  buildAccentOverrideStylesheet,
  buildThemeStylesheet,
  primaryColorOverride,
} from "@openbrf/tokens";

import { ThemeService, type ThemeRendering } from "../themes/theme.service";

/**
 * The public website's whole stylesheet, assembled on the server.
 *
 * The site is served to a browser that runs no JavaScript of ours, so the
 * theming the application does at runtime has to be done here instead: the
 * token values, the typefaces and the association's own accent are written into
 * one inline <style> element on the response.
 *
 * Inline rather than a linked stylesheet, and that is a deliberate trade. A
 * linked file would cache, but it would also be a second request, a second
 * route to keep in step with the theme, and a second thing the content policy
 * has to allow. One document with one style element is the smallest surface: a
 * visitor's browser makes exactly one request per page plus the fonts, and
 * nothing on the page can reach any other host.
 *
 * Every value here comes from the token contract. There is not one literal
 * colour, which is the same rule the application's own components live under -
 * a theme the board installs restyles the website by the same act that restyles
 * the interface.
 */

/**
 * The default theme's typefaces, as the website needs them.
 *
 * The application declares these in apps/web/src/theme/fonts.css, which is a
 * client-side file this process cannot read at runtime; an installed theme
 * brings its own faces and this block is not used. Duplicating the four rules
 * is accepted for now - the alternative is a shared source in theme-tools,
 * which is worth doing when a third caller appears rather than for the second.
 *
 * The paths are absolute and same-origin: the fonts are served from this
 * instance at /fonts, never from a font host. Loading a typeface from a third
 * party would disclose every visitor's address to that party on every page
 * view, which is precisely what a housing cooperative's public website must not
 * do to the people who read it.
 */
const BUILT_IN_FONT_FACES = `@font-face {
  font-family: "Familjen Grotesk";
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url("/fonts/familjen-grotesk-latin.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

@font-face {
  font-family: "Familjen Grotesk";
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url("/fonts/familjen-grotesk-latin-ext.woff2") format("woff2");
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}

@font-face {
  font-family: "Spline Sans Mono";
  font-style: normal;
  font-weight: 400 500;
  font-display: swap;
  src: url("/fonts/spline-sans-mono-latin.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

@font-face {
  font-family: "Spline Sans Mono";
  font-style: normal;
  font-weight: 400 500;
  font-display: swap;
  src: url("/fonts/spline-sans-mono-latin-ext.woff2") format("woff2");
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
`;

/**
 * The website's layout, in tokens.
 *
 * One measure-limited column on the page surface, the header and footer set off
 * by the subtle border rule, nothing that needs a script. The focus ring is the
 * product's own: two pixels of the trust accent, offset, never removed - the
 * only navigation on a page with no JavaScript is the keyboard and the link.
 */
const LAYOUT = `*, *::before, *::after { box-sizing: border-box; }

html {
  background: var(--obrf-surface-page);
  -webkit-text-size-adjust: 100%;
}

body {
  margin: 0;
  background: var(--obrf-surface-page);
  color: var(--obrf-text-primary);
  font-family: var(--obrf-font-ui);
  font-size: 16px;
  line-height: 1.6;
}

.site {
  margin: 0 auto;
  max-width: 44rem;
  padding: 0 1.5rem 4rem;
}

.site-header {
  align-items: center;
  border-bottom: 1px solid var(--obrf-border-subtle);
  display: flex;
  gap: 1rem;
  padding: 1.5rem 0;
}

.site-logo {
  display: block;
  height: 2.5rem;
  width: auto;
}

.site-name {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 0;
}

.site-main {
  padding: 2.5rem 0;
}

.site-title {
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.25;
  margin: 0 0 1.5rem;
}

.site-main p {
  margin: 0 0 1rem;
}

.site-footer {
  border-top: 1px solid var(--obrf-border-subtle);
  color: var(--obrf-text-secondary);
  padding: 1.5rem 0;
}

.site-footer a,
.site-main a {
  color: var(--obrf-accent-trust);
  /* A thumb needs 44px; a line of text gives about 26. */
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  text-underline-offset: 2px;
}

.site-footer a:hover,
.site-main a:hover {
  color: var(--obrf-accent-trust-hover);
}

/*
 * Never removed, only replaced. A page with no script of its own is navigated
 * with the keyboard, and an invisible focus position makes it unusable.
 */
:focus-visible {
  outline: 2px solid var(--obrf-accent-trust);
  outline-offset: 2px;
}
`;

/**
 * Builds the stylesheet for one rendering.
 *
 * The accent override is applied last so it wins at equal specificity, exactly
 * as the running application orders its style elements. A colour the contrast
 * matrix refuses is dropped rather than applied: the settings screen refuses to
 * store one in the first place, so this is the second line, and silently
 * keeping the theme's own legible accent is the right failure.
 */
export function buildSiteStylesheet(input: {
  rendering: ThemeRendering;
  primaryColor: string | null;
}): string {
  const { rendering, primaryColor } = input;

  const blocks = [
    buildThemeStylesheet(rendering.modes),
    rendering.builtIn
      ? BUILT_IN_FONT_FACES
      : ThemeService.fontStylesheet(rendering),
    LAYOUT,
  ];

  if (primaryColor !== null && primaryColor !== "") {
    // Measured against whichever theme renders, never always against the
    // default one: deriving the accent from surfaces that are not on the page
    // would measure the wrong contrast.
    const result = primaryColorOverride(primaryColor, rendering.modes);
    if (result.ok) {
      blocks.push(buildAccentOverrideStylesheet(result.override));
    }
  }

  return withoutMarkupDelimiter(blocks.join("\n"));
}

/**
 * Removes any "<" from the assembled stylesheet.
 *
 * The stylesheet is written into a <style> element, which HTML parses as raw
 * text: the element ends at the first "</style" and nothing before it is
 * escaped. Token values and a theme's font paths are validated where they are
 * stored, but they come from a database column and a package a board installed,
 * so this is the last point that can make "the website has no script" a
 * property of the code. CSS has no syntax that needs the character, so nothing
 * legitimate is lost by refusing it here.
 */
function withoutMarkupDelimiter(css: string): string {
  return css.replaceAll("<", "");
}

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
  flex-wrap: wrap;
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

/*
 * The menu, in two shapes and no script.
 *
 * Narrow first: the whole menu is one list, and a dropdown's items sit under
 * their parent, indented. There is nothing to open, so there is nothing that
 * needs a tap which is not a navigation - which is what a hover-revealed
 * dropdown gets wrong on a telephone, where the tap that would reveal it is
 * the tap that follows the link.
 *
 * From the width where a row of entries fits, the second level is hidden and
 * revealed by hover or by focus reaching inside the group. Keyboard focus
 * counts, which is what makes it usable without a pointer: tabbing onto the
 * parent link opens the group, and the next tab lands on the first item in
 * it. The parent stays a link in both shapes; it is never a control that is
 * also a link, because that is the ambiguity a keyboard cannot resolve.
 */
.site-nav {
  /* Its own row under the association's name until there is room beside it. */
  flex-basis: 100%;
}

.site-nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.site-nav > ul {
  display: flex;
  flex-direction: column;
}

.site-nav a {
  align-items: center;
  color: var(--obrf-text-primary);
  display: flex;
  /* A thumb needs 44px; a line of text gives about 26. */
  min-height: 44px;
  text-decoration: none;
}

.site-nav a:hover {
  color: var(--obrf-accent-trust);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.site-nav-children {
  /* The indent is what says these belong to the entry above them. */
  padding-left: 1rem;
}

@media (min-width: 48rem) {
  .site-nav {
    flex-basis: auto;
    margin-left: auto;
  }

  .site-nav > ul {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0 1.5rem;
  }

  .site-nav-group {
    position: relative;
  }

  .site-nav-group .site-nav-children {
    background: var(--obrf-surface-raised);
    border: 1px solid var(--obrf-border-subtle);
    border-radius: 4px;
    box-shadow: var(--obrf-shadow-raised);
    display: none;
    left: 0;
    min-width: 12rem;
    padding: 0.25rem 0.75rem;
    position: absolute;
    top: 100%;
    z-index: 1;
  }

  .site-nav-group:hover > .site-nav-children,
  .site-nav-group:focus-within > .site-nav-children {
    display: block;
  }
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

/*
 * The page's own title is the single h1, so a heading the board writes starts
 * at the second level and the document keeps one outline whatever is on it.
 */
.site-main h2 {
  font-size: 1.375rem;
  font-weight: 600;
  line-height: 1.3;
  margin: 2rem 0 0.75rem;
}

.site-main h3 {
  font-size: 1.125rem;
  font-weight: 600;
  line-height: 1.35;
  margin: 1.5rem 0 0.5rem;
}

.site-figure {
  margin: 1.5rem 0;
}

/*
 * The picture is bounded by the column rather than by its own dimensions, so a
 * photograph uploaded at whatever size the board's camera produced does not
 * decide the width of the page on a telephone.
 */
.site-figure img {
  border-radius: 4px;
  display: block;
  height: auto;
  max-width: 100%;
}

.site-figure figcaption {
  color: var(--obrf-text-secondary);
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

.site-footer {
  border-top: 1px solid var(--obrf-border-subtle);
  color: var(--obrf-text-secondary);
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.5rem;
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

/*
 * The public forms.
 *
 * Set off on the raised surface, because a form is the one thing on this page
 * that asks the reader for something rather than telling them something. Every
 * control is at least 44px tall: a form on a housing cooperative's website is
 * filled in on a telephone, standing in a stairwell, by somebody who has just
 * found the door broken.
 */
.site-form {
  background: var(--obrf-surface-raised);
  border: 1px solid var(--obrf-border-subtle);
  border-radius: 8px;
  margin: 2rem 0;
  padding: 1.5rem;
}

.site-form h2 {
  margin-top: 0;
}

.site-field {
  display: block;
  margin: 0 0 1rem;
}

.site-field > span {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.site-field-hint {
  color: var(--obrf-text-secondary);
  display: block;
  font-size: 0.8125rem;
  font-weight: 400;
  margin-top: 0.25rem;
}

.site-field input,
.site-field select,
.site-field textarea {
  background: var(--obrf-surface-page);
  border: 1px solid var(--obrf-border-strong);
  border-radius: 4px;
  color: var(--obrf-text-primary);
  font-family: inherit;
  font-size: 1rem;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  width: 100%;
}

.site-field textarea {
  line-height: 1.5;
  resize: vertical;
}

.site-form button {
  background: var(--obrf-accent-trust);
  border: 1px solid var(--obrf-accent-trust);
  border-radius: 4px;
  color: var(--obrf-on-accent-trust);
  cursor: pointer;
  font-family: inherit;
  font-size: 1rem;
  font-weight: 600;
  min-height: 44px;
  padding: 0.5rem 1.25rem;
}

.site-form button:hover {
  background: var(--obrf-accent-trust-hover);
  border-color: var(--obrf-accent-trust-hover);
}

/* Colour is never the only signal: each of these carries its own words. */
.site-form-sent {
  background: var(--obrf-status-ok-soft);
  border-left: 4px solid var(--obrf-status-ok);
  padding: 0.75rem 1rem;
}

.site-form-refused {
  background: var(--obrf-status-danger-soft);
  border-left: 4px solid var(--obrf-status-danger);
  padding: 0.75rem 1rem;
}

/*
 * The decoy field on every public form: out of sight, and out of the
 * accessibility tree by the aria-hidden the markup carries. Clipped rather than
 * displayed as none, because a script reading the page has to find it - that is
 * the whole point of it - while no person ever does.
 */
.site-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
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

import { SITE_LAYOUT_STYLESHEET } from "@openbrf/shared";
import { describe, expect, it } from "vite-plus/test";

import { CANVAS_CLASS, canvasStylesheet } from "./canvas-stylesheet";

/**
 * The page editor draws a page under the website's own rules, scoped to the
 * area it is edited in so they reach nothing else on the screen.
 */

describe("the editing area's stylesheet", () => {
  const css = canvasStylesheet();

  it("is the website's layout, nested under the editing area", () => {
    expect(css.startsWith(`.${CANVAS_CLASS} {`)).toBe(true);
    // Every rule of the website's, after the area's own type.
    const nested = css.slice(css.indexOf(`.${CANVAS_CLASS} {`, 1));
    expect(nested).toContain(".site-main h2 {");
    expect(nested).toContain(".site-banner {");
    expect(nested).toContain(".site-main .site-button-primary {");
  });

  it("changes shape at the width of the page drawn, not of the window", () => {
    expect(SITE_LAYOUT_STYLESHEET).toContain("@media (min-width: 40rem)");
    expect(css).not.toContain("@media (");
    expect(css).toContain("@container site-canvas (min-width: 40rem)");
    expect(css).toContain("container: site-canvas / inline-size;");
  });

  it("sets the website's body type on the editing area", () => {
    expect(css).toMatch(
      /\.site-canvas \{\s*background: var\(--obrf-surface-page\);\s*color: var\(--obrf-text-primary\);/,
    );
  });
});

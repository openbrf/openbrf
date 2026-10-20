import { SITE_LAYOUT_STYLESHEET } from "@openbrf/shared";

/**
 * The website's own stylesheet, for the area a page is edited in.
 *
 * The page editor draws a page with the markup the website renders it in and
 * the rules the website lays it out with, so the board writes it as it will
 * look. The rules are the website's, from @openbrf/shared, rewritten in three
 * ways and no others:
 *
 *   They are nested under the editing area, so they style the page being
 *   edited and nothing else on the screen.
 *
 *   The body's type is set on the editing area, which is the page's body here.
 *
 *   A width the website changes shape at is read as the width of the editing
 *   area rather than of the window - a container query where the website has a
 *   media query - so columns stand side by side in the editor exactly when
 *   they would on a screen as wide as the page is drawn.
 *
 * The token values are not repeated. The application already carries the
 * active theme's tokens and the association's accent, the same ones the
 * website is rendered with, so the page is drawn in the theme it is published
 * in.
 */

/** The class of the element a page is edited in. */
export const CANVAS_CLASS = "site-canvas";

/**
 * What the editor adds to the website's rules.
 *
 * Every block in the editor stands in an element of its own, which the
 * website's rules for the first and last thing in a column or a banner do not
 * expect: those are restated for the block inside it. An empty paragraph says
 * what it is for, in the secondary text colour.
 */
const EDITOR_RULES = `
.site-column > [data-canvas-block]:nth-child(1 of [data-canvas-block]) [data-canvas-content],
.site-column > [data-canvas-block]:nth-child(1 of [data-canvas-block]) [data-canvas-content] :is(p, h2, h3):first-child {
  margin-top: 0;
}

.site-column > [data-canvas-block]:nth-last-child(1 of [data-canvas-block]) [data-canvas-content],
.site-column > [data-canvas-block]:nth-last-child(1 of [data-canvas-block]) [data-canvas-content] p:last-child {
  margin-bottom: 0;
}

.ProseMirror {
  outline: none;
  position: relative;
}

.ProseMirror[data-placeholder]:has(> p:only-child > br:only-child)::before {
  color: var(--obrf-text-secondary);
  content: attr(data-placeholder);
  pointer-events: none;
  position: absolute;
}
`;

/** The stylesheet, scoped to an element with CANVAS_CLASS. */
export function canvasStylesheet(): string {
  const layout = SITE_LAYOUT_STYLESHEET.replaceAll(
    "@media (",
    "@container site-canvas (",
  );
  return `.${CANVAS_CLASS} {
  background: var(--obrf-surface-page);
  color: var(--obrf-text-primary);
  container: site-canvas / inline-size;
  font-family: var(--obrf-font-ui);
  font-size: 16px;
  line-height: 1.6;
}

.${CANVAS_CLASS} {
${layout}
${EDITOR_RULES}
}
`;
}

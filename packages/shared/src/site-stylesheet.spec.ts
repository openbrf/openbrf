import { describe, expect, it } from "vite-plus/test";

import {
  SITE_DOCUMENT_STYLESHEET,
  SITE_LAYOUT_STYLESHEET,
} from "./site-stylesheet.ts";

/**
 * The website's stylesheet is read by the website and by the page editor,
 * which scopes the layout to the area a page is edited in by nesting it under
 * that element. Nesting scopes a rule only when its selector names something
 * inside the page, so the rules for the document itself are kept apart.
 */

/** Every selector at the top level of a stylesheet, outside its at-rules. */
function topLevelSelectors(css: string): string[] {
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < withoutComments.length; at += 1) {
    const character = withoutComments[at];
    if (character === "{") {
      const prelude = withoutComments.slice(start, at).trim();
      if (depth === 0 && !prelude.startsWith("@")) {
        selectors.push(...prelude.split(",").map((one) => one.trim()));
      }
      depth += prelude.startsWith("@") && depth === 0 ? 0 : 1;
      start = at + 1;
    } else if (character === "}") {
      depth = Math.max(depth - 1, 0);
      start = at + 1;
    }
  }
  return selectors;
}

describe("the website's stylesheet", () => {
  it("lays out the page by its classes and the focus ring alone", () => {
    for (const selector of topLevelSelectors(SITE_LAYOUT_STYLESHEET)) {
      expect(selector).toMatch(/^(?:\.|:focus-visible)/);
    }
  });

  it("keeps the document's own rules apart", () => {
    expect(topLevelSelectors(SITE_DOCUMENT_STYLESHEET)).toEqual([
      "*",
      "*::before",
      "*::after",
      "html",
      "body",
    ]);
  });

  it("styles a button by its class, whatever element carries it", () => {
    expect(SITE_LAYOUT_STYLESHEET).toContain(".site-main .site-button {");
    expect(SITE_LAYOUT_STYLESHEET).not.toContain("a.site-button");
  });
});

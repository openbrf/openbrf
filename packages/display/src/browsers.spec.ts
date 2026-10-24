import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { DISPLAY_STYLESHEET } from "./styles.ts";

/**
 * Screens run in a signage shell on Chromium 85 (a 2021 Samsung display). What
 * it lacks is kept out of the package instead of being shimmed by each player,
 * and these guards stop one coming back unnoticed.
 */
describe("the browsers the package runs in", () => {
  const sources = readdirSync(new URL(".", import.meta.url))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
    .map((name) => ({
      name,
      text: readFileSync(new URL(name, import.meta.url), "utf8"),
    }));

  it.each([
    ["Element.replaceChildren (Chromium 86)", /\.replaceChildren\(/],
    ["Array.prototype.at (92)", /\)\.at\(|\]\.at\(/],
    ["Object.hasOwn (93)", /Object\.hasOwn\(/],
    ["structuredClone (98)", /structuredClone\(/],
    ["Array.prototype.findLast (97)", /\.findLast(Index)?\(/],
  ])("calls no %s", (_, pattern) => {
    for (const { name, text } of sources) {
      expect(text.match(pattern), name).toBeNull();
    }
  });

  it.each([
    ["inset (Chromium 87)", /(^|[\s{;])inset\s*:/m],
    ["a selector list in :not() (88)", /:not\([^)]*,/],
    ["a selector list in :is() or :where() (88)", /:(is|where)\(/],
    ["aspect-ratio (88)", /aspect-ratio\s*:/],
    ["an @layer rule (99)", /@layer\b/],
    ["color-mix() (111)", /color-mix\(/],
    ["the :has() selector (105)", /:has\(/],
    ["viewport units dvh, svh and lvh (108)", /\d(dvh|svh|lvh)\b/],
  ])("writes no %s in its stylesheet", (_, pattern) => {
    expect(DISPLAY_STYLESHEET.match(pattern)).toBeNull();
  });
});

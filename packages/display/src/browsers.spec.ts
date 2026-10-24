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

  // Each guard names a sample it must catch, so a pattern too narrow to
  // catch the call or rule it is for fails here instead of passing quietly.
  it.each([
    [
      "Element.replaceChildren (Chromium 86)",
      /\.replaceChildren\(/,
      "element.replaceChildren(row)",
    ],
    ["Array.prototype.at (92)", /\.at\(/, "rotation.at(-1)"],
    ["Object.hasOwn (93)", /Object\.hasOwn\(/, "Object.hasOwn(body, key)"],
    ["structuredClone (98)", /structuredClone\(/, "structuredClone(slide)"],
    [
      "Array.prototype.findLast (97)",
      /\.findLast(Index)?\(/,
      "slides.findLastIndex(isShown)",
    ],
  ])("calls no %s", (_, pattern, sample) => {
    expect(sample).toMatch(pattern);
    for (const { name, text } of sources) {
      expect(text.match(pattern), name).toBeNull();
    }
  });

  it.each([
    ["inset (Chromium 87)", /(^|[\s{;])inset\s*:/m, ".off { inset: 0; }"],
    ["a selector list in :not() (88)", /:not\([^)]*,/, "tr > :not(td, th) {}"],
    [
      "a selector list in :is() or :where() (88)",
      /:(is|where)\(/,
      ":where(h1, h2) {}",
    ],
    ["aspect-ratio (88)", /aspect-ratio\s*:/, "img { aspect-ratio: 16 / 9; }"],
    ["an @layer rule (99)", /@layer\b/, "@layer base {}"],
    [
      "color-mix() (111)",
      /color-mix\(/,
      "color: color-mix(in srgb, red, blue);",
    ],
    ["the :has() selector (105)", /:has\(/, "section:has(img) {}"],
    [
      "viewport units dvh, svh and lvh (108)",
      /\d(dvh|svh|lvh)\b/,
      "height: 100dvh;",
    ],
  ])("writes no %s in its stylesheet", (_, pattern, sample) => {
    expect(sample).toMatch(pattern);
    expect(DISPLAY_STYLESHEET.match(pattern)).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { shortenText, shortenTexts } from "./text.ts";

describe("shortenText", () => {
  it("leaves a text within its limit as it is", () => {
    expect(shortenText("Cleaning day", 12)).toBe("Cleaning day");
  });

  it("ends a shortened text with an ellipsis counted within the limit", () => {
    expect(shortenText("Cleaning day in the courtyard", 12)).toBe(
      "Cleaning da…",
    );
  });

  it("drops the space before the ellipsis", () => {
    expect(shortenText("Cleaning day in the courtyard", 10)).toBe("Cleaning…");
  });

  it("never cuts a character outside the basic plane in two", () => {
    const shortened = shortenText("ab🏠cd", 4);

    expect(shortened).toBe("ab…");
    expect(shortened.length).toBeLessThanOrEqual(4);
  });
});

describe("shortenTexts", () => {
  it("keeps texts within the limit together and drops blank ones", () => {
    expect(shortenTexts(["One.", " ", "Two."], 100)).toEqual(["One.", "Two."]);
  });

  it("puts the ellipsis on the last kept text when too little room is left", () => {
    expect(shortenTexts(["a".repeat(95), "b".repeat(30)], 100)).toEqual([
      `${"a".repeat(95)}…`,
    ]);
  });
});

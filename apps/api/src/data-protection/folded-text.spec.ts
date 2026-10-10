import { describe, expect, it } from "vitest";

import { foldedText } from "./folded-text";

describe("foldedText", () => {
  const fields = { oneLine: ["title"], freeText: ["body"] } as const;

  it("folds a one-line field to one line and a free-text field to text that keeps its breaks", () => {
    expect(
      foldedText({ title: " A​  b\n c ", body: "x­ y\nz１" }, fields),
    ).toEqual({ title: "A b c", body: "x y\nz1" });
  });

  it("leaves a field it was not told about, and a value that is not a string", () => {
    const input = { other: "a​b", title: null, body: undefined, n: 1 };

    expect(foldedText(input, fields)).toEqual(input);
  });

  it("does not change its input", () => {
    const input = { title: "a​b" };

    foldedText(input, fields);

    expect(input.title).toBe("a​b");
  });
});

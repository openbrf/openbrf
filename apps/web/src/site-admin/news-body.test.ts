import { describe, expect, it } from "vite-plus/test";

import { contentFromText, isPlainText, textFromContent } from "./news-body";

/**
 * The mapping between the box the board types in and the blocks the platform
 * stores.
 *
 * It has to round-trip: opening a news item to fix a comma and saving it again
 * must store what was already there. That is asserted here rather than left to
 * the screen, because a mapping that quietly rewrites a body is the kind of
 * fault nobody notices until the third edit.
 */

describe("reading what the board typed", () => {
  it("makes a paragraph of each block of text", () => {
    expect(contentFromText("Först.\n\nSedan.")).toEqual({
      blocks: [
        { type: "paragraph", runs: [{ text: "Först." }] },
        { type: "paragraph", runs: [{ text: "Sedan." }] },
      ],
    });
  });

  it("joins the lines inside one paragraph, because a wrap is not a break", () => {
    expect(contentFromText("En mening\nsom fortsätter.")).toEqual({
      blocks: [
        { type: "paragraph", runs: [{ text: "En mening som fortsätter." }] },
      ],
    });
  });

  it("makes a subheading of a line that asks for one", () => {
    expect(contentFromText("## Boka så här\n\nRing på.")).toEqual({
      blocks: [
        { type: "heading", level: 2, runs: [{ text: "Boka så här" }] },
        { type: "paragraph", runs: [{ text: "Ring på." }] },
      ],
    });
  });

  it("keeps a paragraph that begins with a tag a paragraph", () => {
    // Without the space it is a hashtag, and a hashtag is not a subheading.
    expect(contentFromText("##årsstämma på torsdag.")).toEqual({
      blocks: [
        { type: "paragraph", runs: [{ text: "##årsstämma på torsdag." }] },
      ],
    });
  });

  it("keeps nothing from the blank lines an editor leaves behind", () => {
    expect(contentFromText("Hej.\n\n\n   \n\n")).toEqual({
      blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
    });
  });

  it("keeps nothing from a heading with no words after the marks", () => {
    expect(contentFromText("##\n\nHej.")).toEqual({
      blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
    });
  });
});

describe("writing stored blocks back out", () => {
  it("round-trips a body through the box and back", () => {
    const text = "Först.\n\n## Rubrik\n\nSedan.";

    expect(textFromContent(contentFromText(text))).toBe(text);
  });

  it("contributes nothing for a block this editor has no spelling for", () => {
    expect(
      textFromContent({
        blocks: [
          { type: "paragraph", runs: [{ text: "Hej." }] },
          // A run with no text: nothing to write, and no placeholder either.
          { type: "paragraph", runs: [] },
        ],
      }),
    ).toBe("Hej.");
  });
});

describe("deciding whether this editor can hold a stored body", () => {
  it("accepts what it can write back out unchanged", () => {
    expect(isPlainText(contentFromText("Först.\n\n## Rubrik\n\nSedan."))).toBe(
      true,
    );
  });

  it("refuses a run carrying a mark it has no spelling for", () => {
    expect(
      isPlainText({
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "Tvättstugan", link: "https://example.org/" }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("refuses a paragraph it would read back in as a subheading", () => {
    expect(
      isPlainText({
        blocks: [{ type: "paragraph", runs: [{ text: "## Inte en rubrik" }] }],
      }),
    ).toBe(false);
  });

  it("refuses a paragraph whose mark only follows leading whitespace", () => {
    // Reading the text back in trims the paragraph first, so this one would
    // be stored as a subheading by an edit that changed nothing.
    expect(
      isPlainText({
        blocks: [
          { type: "paragraph", runs: [{ text: "  ## Inte en rubrik" }] },
        ],
      }),
    ).toBe(false);
  });

  it("refuses a heading deeper than the one level it writes", () => {
    expect(
      isPlainText({
        blocks: [{ type: "heading", level: 3, runs: [{ text: "Rubrik" }] }],
      }),
    ).toBe(false);
  });
});

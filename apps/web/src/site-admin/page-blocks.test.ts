import { describe, expect, it } from "vitest";

import type { PageBlock } from "../api/site";
import {
  emptyBlock,
  insertBlock,
  moveBlock,
  needsPhotoConsent,
  removeBlock,
  replaceBlock,
  replaceBlockWith,
  runsToText,
  scanPage,
  submittableBlocks,
  textToRuns,
} from "./page-blocks";

/**
 * Arranging a page's blocks, without a text editor or a network.
 *
 * The screen is a thin thing over these functions on purpose: which block sits
 * where, and what is worth sending, are decisions a test should be able to
 * make without rendering anything.
 */

const TEXT: PageBlock = { type: "paragraph", runs: [{ text: "Hej." }] };
const HEADING: PageBlock = {
  type: "heading",
  level: 2,
  runs: [{ text: "Styrelsen" }],
};
const PICTURE: PageBlock = {
  type: "image",
  mediaFileId: "file-1",
  alt: "Garden",
};

describe("arranging blocks", () => {
  it("adds an empty block of the kind asked for", () => {
    expect(emptyBlock("heading")).toEqual({
      type: "heading",
      level: 2,
      runs: [],
    });
    expect(insertBlock([TEXT], "image")).toHaveLength(2);
  });

  it("moves a block one step and stops at either end", () => {
    expect(moveBlock([TEXT, HEADING], 1, -1)).toEqual([HEADING, TEXT]);
    expect(moveBlock([TEXT, HEADING], 0, -1)).toEqual([TEXT, HEADING]);
    expect(moveBlock([TEXT, HEADING], 1, 1)).toEqual([TEXT, HEADING]);
  });

  it("replaces and removes by position", () => {
    expect(replaceBlock([TEXT, HEADING], 0, PICTURE)).toEqual([
      PICTURE,
      HEADING,
    ]);
    expect(removeBlock([TEXT, HEADING], 0)).toEqual([HEADING]);
  });

  it("splices one block into several", () => {
    // A paragraph the board split by pressing return comes back as more than
    // one, because the mapping out of the editor is paragraph by paragraph.
    const split = replaceBlockWith([TEXT, HEADING], 0, [
      { type: "paragraph", runs: [{ text: "Ett." }] },
      { type: "paragraph", runs: [{ text: "Tva." }] },
    ]);

    expect(split).toHaveLength(3);
    expect(split[2]).toEqual(HEADING);
  });
});

describe("what is worth sending", () => {
  it("leaves out a block nothing has been written in yet", () => {
    const blocks: PageBlock[] = [
      TEXT,
      { type: "paragraph", runs: [] },
      { type: "heading", level: 3, runs: [{ text: "" }] },
      { type: "image", mediaFileId: "", alt: "" },
      PICTURE,
    ];

    expect(submittableBlocks(blocks)).toEqual([TEXT, PICTURE]);
  });

  it("reads a text block as one string and back", () => {
    expect(runsToText([{ text: "Sty" }, { text: "relsen", bold: true }])).toBe(
      "Styrelsen",
    );
    expect(textToRuns("Styrelsen")).toEqual([{ text: "Styrelsen" }]);
    expect(textToRuns("")).toEqual([]);
  });
});

describe("warning before the server refuses", () => {
  it("finds a personal identity number in the title and in a block", () => {
    const hits = scanPage({
      title: "Anna 19811218-9876",
      blocks: [
        TEXT,
        { type: "paragraph", runs: [{ text: "Ring 19811218-9876." }] },
      ],
    });

    expect(hits).toEqual([{ block: null }, { block: 1 }]);
  });

  it("leaves an ordinary date and an organisation number alone", () => {
    expect(
      scanPage({
        title: "Stamma 2026",
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "Foreningen har organisationsnummer 769600-0000." }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("reads an image's description as published prose", () => {
    expect(
      scanPage({
        title: "Garden",
        blocks: [
          {
            type: "image",
            mediaFileId: "file-1",
            alt: "Anna 19811218-9876",
          },
        ],
      }),
    ).toEqual([{ block: 0 }]);
  });
});

describe("pictures of identifiable people", () => {
  it("are what the consent confirmation is asked about", () => {
    expect(needsPhotoConsent([TEXT, PICTURE], new Set(["file-1"]))).toBe(true);
    expect(needsPhotoConsent([TEXT, PICTURE], new Set(["file-2"]))).toBe(false);
    expect(needsPhotoConsent([TEXT], new Set(["file-1"]))).toBe(false);
  });
});

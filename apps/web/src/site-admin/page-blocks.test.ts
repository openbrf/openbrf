import { describe, expect, it } from "vitest";

import type { PageBlock } from "../api/site";
import {
  blocksOf,
  blockText,
  type EditorBlock,
  editorBlocks,
  emptyBlock,
  emptyFaqItem,
  insertBlock,
  INSERTABLE,
  moveBlock,
  needsPhotoConsent,
  newBlockWith,
  removeBlock,
  removeFaqItem,
  replaceBlock,
  replaceBlockWith,
  runsToText,
  scanPage,
  submittableBlocks,
  textToRuns,
  withBlock,
  withFaqItem,
  withUploadedPicture,
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

const EMPTY_PICTURE: PageBlock = { type: "image", mediaFileId: "", alt: "" };

/** The ids of a list, which is what the screen keys everything by. */
function idsOf(entries: readonly EditorBlock[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("arranging blocks", () => {
  it("adds an empty block of the kind asked for", () => {
    expect(emptyBlock("heading")).toEqual({
      type: "heading",
      level: 2,
      runs: [],
    });
    expect(insertBlock(editorBlocks([TEXT]), "image")).toHaveLength(2);
  });

  it("gives every block an identity of its own", () => {
    const entries = editorBlocks([TEXT, HEADING, PICTURE]);

    expect(new Set(idsOf(entries)).size).toBe(3);
    expect(blocksOf(entries)).toEqual([TEXT, HEADING, PICTURE]);
    // And a block added later gets one nothing already on the page has.
    expect(new Set(idsOf(insertBlock(entries, "paragraph"))).size).toBe(4);
  });

  it("moves a block one step and stops at either end", () => {
    const entries = editorBlocks([TEXT, HEADING]);
    const [first, second] = idsOf(entries);

    expect(blocksOf(moveBlock(entries, 1, -1))).toEqual([HEADING, TEXT]);
    expect(blocksOf(moveBlock(entries, 0, -1))).toEqual([TEXT, HEADING]);
    expect(blocksOf(moveBlock(entries, 1, 1))).toEqual([TEXT, HEADING]);

    // The identity travels with the block, which is what keeps the editor a
    // paragraph is typed into, and the declaration a picture carries, with the
    // block rather than with the position it used to sit at.
    expect(idsOf(moveBlock(entries, 1, -1))).toEqual([second, first]);
  });

  it("replaces and removes by position", () => {
    const entries = editorBlocks([TEXT, HEADING]);
    const [first] = entries;

    expect(
      blocksOf(
        replaceBlock(entries, 0, withBlock(first as EditorBlock, PICTURE)),
      ),
    ).toEqual([PICTURE, HEADING]);
    // Replacing a block's content is not replacing the block: what the board
    // is typing into stays the same block.
    expect(
      idsOf(replaceBlock(entries, 0, withBlock(first as EditorBlock, PICTURE))),
    ).toEqual(idsOf(entries));
    expect(blocksOf(removeBlock(entries, 0))).toEqual([HEADING]);
    expect(idsOf(removeBlock(entries, 0))).toEqual([idsOf(entries)[1]]);
  });

  it("splices one block into several", () => {
    // A paragraph the board split by pressing return comes back as more than
    // one, because the mapping out of the editor is paragraph by paragraph.
    const entries = editorBlocks([TEXT, HEADING]);
    const split = replaceBlockWith(entries, 0, [
      { id: "kept", block: { type: "paragraph", runs: [{ text: "Ett." }] } },
      { id: "added", block: { type: "paragraph", runs: [{ text: "Tva." }] } },
    ]);

    expect(split).toHaveLength(3);
    expect(split[2]).toEqual(entries[1]);
    // The heading below the split keeps its own identity rather than taking on
    // whatever now sits at its old position.
    expect(idsOf(split)[2]).toBe(idsOf(entries)[1]);
  });

  it("gives a block split out of another an identity of its own", () => {
    // Splitting the same paragraph twice is the case that matters. An identity
    // derived from the block being split - its own id with the position
    // appended - comes out the same both times, and the two blocks then share
    // a React key: one of the editors is not rebuilt, so it goes on showing
    // the whole document it was split out of while the block beside it shows
    // part of the same text again.
    const paragraph = (text: string): PageBlock => ({
      type: "paragraph",
      runs: [{ text }],
    });

    const entries = editorBlocks([TEXT]);
    const once = replaceBlockWith(entries, 0, [
      newBlockWith(paragraph("Ett.")),
      newBlockWith(paragraph("Tva.")),
    ]);
    const twice = replaceBlockWith(once, 0, [
      newBlockWith(paragraph("Ett.")),
      newBlockWith(paragraph("Ett och ett halvt.")),
    ]);

    expect(twice).toHaveLength(3);
    expect(new Set(idsOf(twice)).size).toBe(twice.length);
  });

  it("records an uploaded file on the picture that asked for it", () => {
    // The list can have moved while the bytes were on their way, so the block
    // is found by identity rather than by where it was when the upload began.
    const entries = editorBlocks([EMPTY_PICTURE, TEXT]);
    const picture = idsOf(entries)[0] as string;
    const moved = moveBlock(entries, 0, 1);

    const stored = withUploadedPicture(moved, picture, "file-9");

    expect(blocksOf(stored)).toEqual([
      TEXT,
      { type: "image", mediaFileId: "file-9", alt: "" },
    ]);
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

    // And where each one sits on the screen, because a refusal names a
    // position in what was sent and the board is looking at the whole list.
    expect(submittableBlocks(blocks)).toEqual({
      blocks: [TEXT, PICTURE],
      positions: [0, 4],
    });
  });

  it("reads a text block as one string and back", () => {
    expect(runsToText([{ text: "Sty" }, { text: "relsen", bold: true }])).toBe(
      "Styrelsen",
    );
    expect(textToRuns("Styrelsen")).toEqual([{ text: "Styrelsen" }]);
    expect(textToRuns("")).toEqual([]);
  });
});

describe("the blocks that name what the instance already holds", () => {
  it("are inserted empty and are ready as they are", () => {
    // There is nothing on any of them for the board to fill in: what they show
    // is decided when the page is rendered, against whoever is reading it.
    const ready: PageBlock[] = [
      emptyBlock("documentList"),
      emptyBlock("boardRoster"),
      emptyBlock("associationFacts"),
    ];

    expect(ready).toEqual([
      { type: "documentList" },
      { type: "boardRoster" },
      { type: "associationFacts" },
    ]);
    expect(submittableBlocks(ready).positions).toEqual([0, 1, 2]);
  });

  it("carry no text of their own for the scan to read", () => {
    // What they show is scanned where it was written: on the news item, in the
    // archive, on the facts screen.
    expect(
      scanPage({
        title: "Om foreningen",
        blocks: [
          { type: "documentList", category: "Protokoll" },
          { type: "boardRoster" },
          { type: "associationFacts" },
          { type: "newsTeaser", count: 3 },
        ],
      }),
    ).toEqual([]);
  });

  it("do not offer the blocks another feature's screen places", () => {
    // A page can carry a form or a news teaser, and the editor arranges one it
    // is handed. Inserting one is the other screen's to offer.
    expect(INSERTABLE).not.toContain("contactForm");
    expect(INSERTABLE).not.toContain("newsTeaser");
  });
});

describe("questions and answers", () => {
  it("start as one empty pair, which is not worth sending", () => {
    const block = emptyBlock("faq");

    expect(block).toEqual({ type: "faq", items: [emptyFaqItem()] });
    expect(submittableBlocks([block]).blocks).toEqual([]);
  });

  it("are sent once a question has an answer under it", () => {
    const block: PageBlock = {
      type: "faq",
      items: [
        { question: "Var finns tvattstugan?", answer: [] },
        {
          question: "Nar tommer vi soporna?",
          answer: [{ text: "Pa mandag." }],
        },
      ],
    };

    // Sent whole: the API drops the half-written entry, exactly as it drops an
    // empty paragraph, and one finished question is a block worth having.
    expect(submittableBlocks([block]).blocks).toEqual([block]);
  });

  it("rewrite and remove one pair without touching the others", () => {
    const items = [
      { question: "Ett?", answer: [{ text: "Ja." }] },
      { question: "Tva?", answer: [{ text: "Nej." }] },
    ];

    expect(
      withFaqItem(items, 1, {
        question: "Tva?",
        answer: [{ text: "Kanske." }],
      }),
    ).toEqual([
      { question: "Ett?", answer: [{ text: "Ja." }] },
      { question: "Tva?", answer: [{ text: "Kanske." }] },
    ]);
    expect(removeFaqItem(items, 0)).toEqual([
      { question: "Tva?", answer: [{ text: "Nej." }] },
    ]);
  });

  it("put both halves in front of the scan", () => {
    // A question is as good a place to paste a personal identity number into
    // as an answer, and both are published.
    expect(
      blockText({
        type: "faq",
        items: [{ question: "Vem?", answer: [{ text: "Anna." }] }],
      }),
    ).toBe("Vem? Anna.");
    expect(
      scanPage({
        title: "Vanliga fragor",
        blocks: [
          {
            type: "faq",
            items: [
              {
                question: "Vem ar 19811218-9876?",
                answer: [{ text: "Anna." }],
              },
            ],
          },
        ],
      }),
    ).toEqual([{ block: 0 }]);
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

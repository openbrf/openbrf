import { describe, expect, it } from "vite-plus/test";

import {
  NESTED_BLOCKS,
  PAGE_BLOCKS,
  type PluginBlockDeclaration,
} from "@openbrf/shared";

import type { PageBlock } from "../api/site";
import { putIn, takeOut, updateBlock } from "./block-tree";
import {
  addParagraph,
  blockLabel,
  blocksOf,
  blockText,
  type EditorBlock,
  type InsertableBlock,
  editorBlocks,
  editorRegistry,
  emptyBlock,
  emptyFaqItem,
  INSERTABLE,
  moveBlock,
  moveInColumn,
  needsPhotoConsent,
  newBlockWith,
  newEditorBlock,
  newPluginBlock,
  pluginBlockOf,
  pluginSettingsOf,
  removeFaqItem,
  removeParagraph,
  replaceBlockWith,
  replaceInColumnWith,
  replaceParagraphWith,
  runsToText,
  scanPage,
  storedAs,
  submittableBlocks,
  textToRuns,
  unfinishedStoredBlocks,
  unfinishedWork,
  withColumnCount,
  withFaqItem,
  withPluginSetting,
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

/** A columns entry with an empty block of a kind added to one column. */
function addToColumn(
  entry: EditorBlock,
  column: number,
  kind: InsertableBlock,
): EditorBlock {
  const blocks =
    entry.block.type === "columns"
      ? (entry.block.columns[column]?.blocks.length ?? 0)
      : 0;
  return putIn(
    [entry],
    { list: "column", parent: entry.id, column, at: blocks },
    newEditorBlock(kind),
  )[0] as EditorBlock;
}

describe("arranging blocks", () => {
  it("adds an empty block of the kind asked for", () => {
    expect(emptyBlock("heading")).toEqual({
      type: "heading",
      level: 2,
      runs: [],
    });
    expect(newEditorBlock("image").block).toEqual({
      type: "image",
      mediaFileId: "",
      alt: "",
    });
  });

  it("gives every block an identity of its own", () => {
    const entries = editorBlocks([TEXT, HEADING, PICTURE]);

    expect(new Set(idsOf(entries)).size).toBe(3);
    expect(blocksOf(entries)).toEqual([TEXT, HEADING, PICTURE]);
    // And a block added later gets one nothing already on the page has.
    expect(new Set(idsOf([...entries, newEditorBlock("paragraph")])).size).toBe(
      4,
    );
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

  it("replaces and removes by identity", () => {
    const entries = editorBlocks([TEXT, HEADING]);
    const [first, second] = idsOf(entries);

    expect(blocksOf(updateBlock(entries, first ?? "", PICTURE))).toEqual([
      PICTURE,
      HEADING,
    ]);
    // Replacing a block's content is not replacing the block: what the board
    // is typing into stays the same block.
    expect(idsOf(updateBlock(entries, first ?? "", PICTURE))).toEqual(
      idsOf(entries),
    );
    const out = takeOut(entries, first ?? "");
    expect(blocksOf(out?.entries ?? [])).toEqual([HEADING]);
    expect(idsOf(out?.entries ?? [])).toEqual([second]);
  });

  it("splices one block into several", () => {
    // A paragraph the board split by pressing return comes back as more than
    // one, because the mapping out of the editor is paragraph by paragraph.
    const entries = editorBlocks([TEXT, HEADING]);
    const split = replaceBlockWith(entries, 0, [
      {
        id: "kept",
        block: { type: "paragraph", runs: [{ text: "Ett." }] },
        stored: true,
      },
      {
        id: "added",
        block: { type: "paragraph", runs: [{ text: "Tva." }] },
        stored: false,
      },
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

  it("keeps the blocks it has nothing to fill in on, known or not", () => {
    // A save carries the whole page: a block left out of the body is deleted.
    const unknown = { type: "mapEmbed", zoom: 12 } as unknown as PageBlock;
    const blocks: PageBlock[] = [
      { type: "controllerContact" },
      { type: "paragraph", runs: [] },
      unknown,
      TEXT,
    ];

    expect(submittableBlocks(blocks)).toEqual({
      blocks: [{ type: "controllerContact" }, unknown, TEXT],
      positions: [0, 2, 3],
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
    // archive, on the facts screen, on the event.
    expect(
      scanPage({
        title: "Om foreningen",
        blocks: [
          { type: "documentList", category: "Protokoll" },
          { type: "boardRoster" },
          { type: "associationFacts" },
          { type: "newsTeaser", count: 3 },
          { type: "eventCalendar", count: 3 },
        ],
      }),
    ).toEqual([]);
  });

  it("start the calendar on a count the API accepts", () => {
    // The one of them with something for the board to decide, and it is a
    // number of dates rather than a date: which dates the block shows is read
    // when the page is rendered, against whoever is reading it.
    const block = emptyBlock("eventCalendar");

    expect(INSERTABLE).toContain("eventCalendar");
    expect(block).toEqual({ type: "eventCalendar", count: 3 });
    expect(submittableBlocks([block]).blocks).toEqual([block]);
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

  it("scan the binder a document list prints as its heading", () => {
    expect(blockText({ type: "documentList" })).toEqual({
      words: "",
      addresses: [],
      unreadableAddress: false,
    });
    expect(
      scanPage({
        title: "Handlingar",
        blocks: [
          { type: "documentList", category: "Handlingar 19811218-9876" },
        ],
      }),
    ).toEqual([{ block: 0 }]);
  });

  it("put both halves in front of the scan", () => {
    // A question is as good a place to paste a personal identity number into
    // as an answer, and both are published.
    expect(
      blockText({
        type: "faq",
        items: [{ question: "Vem?", answer: [{ text: "Anna." }] }],
      }),
    ).toEqual({ words: "Vem? Anna.", addresses: [], unreadableAddress: false });
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

  it("reads a link's address, which the page publishes in its HTML", () => {
    expect(
      scanPage({
        title: "Kontakt",
        blocks: [
          TEXT,
          {
            type: "paragraph",
            runs: [
              {
                text: "Skriv till Anna",
                link: "mailto:anna@exempel.se?subject=19811218%2D9876",
              },
            ],
          },
        ],
      }),
    ).toEqual([{ block: 1 }]);
  });

  it("warns about an address escaped too deeply to read, in an FAQ answer too", () => {
    // What the API refuses: decoding it to the end could take a thousand
    // passes, so it is held against its block unread.
    const deep = `/s?q=%${"25".repeat(10)}2D`;
    expect(
      scanPage({
        title: "Kontakt",
        blocks: [
          { type: "paragraph", runs: [{ text: "Se", link: deep }] },
          {
            type: "faq",
            items: [
              { question: "Var?", answer: [{ text: "Här", link: deep }] },
            ],
          },
        ],
      }),
    ).toEqual([{ block: 0 }, { block: 1 }]);
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

describe("the blocks the registry declares", () => {
  it("are offered prose first, then pictures and layout, then the association's", () => {
    expect(INSERTABLE).toEqual([
      "paragraph",
      "heading",
      "image",
      "button",
      "imageText",
      "banner",
      "columns",
      "eventCalendar",
      "documentList",
      "boardRoster",
      "associationFacts",
      "faq",
    ]);
    expect(PAGE_BLOCKS.definition("faq")?.editor.insert).toBe(
      "siteAdmin.editor.add.faq",
    );
  });

  it("are named by their own label", () => {
    expect(blockLabel("boardRoster")).toBe(
      "siteAdmin.editor.blocks.boardRoster",
    );
  });
});

describe("a block of a plugin that is not installed", () => {
  const POLL: PageBlock = {
    type: "example-plugin/poll",
    question: "Ska vi måla om trapphuset?",
  };

  it("is named as a plugin's block rather than by its type id", () => {
    expect(blockLabel(POLL.type)).toBe("siteAdmin.editor.blocks.unregistered");
  });

  it("is sent with the page, in its place, so a save does not delete it", () => {
    expect(submittableBlocks([TEXT, POLL, EMPTY_PICTURE, HEADING])).toEqual({
      blocks: [TEXT, POLL, HEADING],
      positions: [0, 1, 3],
    });
  });

  it("is warned about when it holds a personal identity number", () => {
    expect(
      scanPage({
        title: "Omröstning",
        blocks: [{ type: "example-plugin/poll", question: "19811218-9876" }],
      }),
    ).toEqual([{ block: 0 }]);
  });
});

describe("columns in the editor", () => {
  const BUTTON: PageBlock = {
    type: "button",
    label: "Läs stadgarna",
    target: { kind: "page", pageId: "built-in-news" },
    style: "primary",
  };

  /** The blocks of each column of a columns entry. */
  function columnsOf(entry: EditorBlock): PageBlock[][] {
    return entry.block.type === "columns"
      ? entry.block.columns.map((column) => column.blocks)
      : [];
  }

  it("offer only the blocks a column may hold", () => {
    expect(NESTED_BLOCKS.map((definition) => definition.type)).toEqual([
      "paragraph",
      "heading",
      "image",
      "button",
    ]);
  });

  it("start as two empty columns, each with its own list of identities", () => {
    const entry = newEditorBlock("columns");
    expect(columnsOf(entry)).toEqual([[], []]);
    expect(entry.nested).toEqual([[], []]);
  });

  it("keep each block's identity through a move, so its editor follows it", () => {
    let entry = addToColumn(newEditorBlock("columns"), 0, "paragraph");
    entry = addToColumn(entry, 0, "heading");
    const [first, second] = entry.nested?.[0] ?? [];
    const moved = moveInColumn(entry, 0, 1, -1);
    expect(columnsOf(moved)[0]?.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
    ]);
    expect(moved.nested?.[0]).toEqual([second, first]);
    // Past either end the column is left alone.
    expect(moveInColumn(moved, 0, 0, -1)).toBe(moved);
  });

  it("give the paragraphs a return splits off identities of their own", () => {
    const entry = addToColumn(newEditorBlock("columns"), 1, "paragraph");
    const kept = entry.nested?.[1]?.[0];
    const { entry: split, added } = replaceInColumnWith(entry, 1, 0, [
      { type: "paragraph", runs: [{ text: "Ett." }] },
      { type: "paragraph", runs: [{ text: "Två." }] },
    ]);
    expect(columnsOf(split)[1]).toHaveLength(2);
    expect(split.nested?.[1]).toEqual([kept, ...added]);
    expect(added).toHaveLength(1);
    expect(added[0]).not.toBe(kept);
  });

  it("move what a column held into the one before it when it is taken away", () => {
    let entry = withColumnCount(newEditorBlock("columns"), 3);
    entry = addToColumn(entry, 2, "button");
    entry = updateBlock(
      [entry],
      entry.nested?.[2]?.[0] ?? "",
      BUTTON,
    )[0] as EditorBlock;
    entry = addToColumn(entry, 1, "paragraph");
    const narrower = withColumnCount(entry, 2);
    expect(columnsOf(narrower)).toHaveLength(2);
    expect(columnsOf(narrower)[1]?.map((block) => block.type)).toEqual([
      "paragraph",
      "button",
    ]);
    expect(narrower.nested?.[1]).toHaveLength(2);
  });

  it("take a block out with its identity", () => {
    let entry = addToColumn(newEditorBlock("columns"), 0, "paragraph");
    entry = addToColumn(entry, 0, "image");
    const removed = takeOut([entry], entry.nested?.[0]?.[0] ?? "")
      ?.entries[0] as EditorBlock;
    expect(columnsOf(removed)[0]?.map((block) => block.type)).toEqual([
      "image",
    ]);
    expect(removed.nested?.[0]).toEqual([entry.nested?.[0]?.[1]]);
  });

  it("record an uploaded picture on the block in a column it was chosen for", () => {
    let entry = addToColumn(newEditorBlock("columns"), 0, "image");
    entry = addToColumn(entry, 0, "image");
    const second = entry.nested?.[0]?.[1] ?? "";
    // Moved while the bytes were on their way.
    const moved = moveInColumn(entry, 0, 1, -1);
    const [stored] = withUploadedPicture([moved], second, "file-7");
    expect(columnsOf(stored as EditorBlock)[0]).toEqual([
      { type: "image", mediaFileId: "file-7", alt: "" },
      { type: "image", mediaFileId: "", alt: "" },
    ]);
  });

  it("are sent without the pictures and paragraphs nobody finished", () => {
    const block: PageBlock = {
      type: "columns",
      columns: [
        { blocks: [TEXT, EMPTY_PICTURE] },
        { blocks: [{ type: "paragraph", runs: [] }] },
      ],
    };
    expect(submittableBlocks([block]).blocks).toEqual([
      { type: "columns", columns: [{ blocks: [TEXT] }, { blocks: [] }] },
    ]);
  });

  it("ask for the consent of a picture inside them", () => {
    const block: PageBlock = {
      type: "columns",
      columns: [{ blocks: [PICTURE] }, { blocks: [] }],
    };
    expect(needsPhotoConsent([block], new Set(["file-1"]))).toBe(true);
  });

  it("are warned about when a block inside them holds a personal identity number", () => {
    const block: PageBlock = {
      type: "columns",
      columns: [
        { blocks: [TEXT] },
        { blocks: [{ type: "paragraph", runs: [{ text: "19811218-9876" }] }] },
      ],
    };
    expect(scanPage({ title: "Kolumner", blocks: [HEADING, block] })).toEqual([
      { block: 1 },
    ]);
  });
});

describe("a picture beside text in the editor", () => {
  it("keeps an identity for each paragraph through a split and a removal", () => {
    let entry = newEditorBlock("imageText");
    expect(entry.nested?.[0]).toHaveLength(1);
    const first = entry.nested?.[0]?.[0];
    const split = replaceParagraphWith(entry, 0, [
      [{ text: "Ett." }],
      [{ text: "Två." }],
    ]);
    entry = split.entry;
    expect(entry.nested?.[0]).toEqual([first, ...split.added]);
    entry = addParagraph(entry);
    expect(entry.nested?.[0]).toHaveLength(3);
    const removed = removeParagraph(entry, 0);
    expect(removed.nested?.[0]).toEqual(entry.nested?.[0]?.slice(1));
    expect(
      removed.block.type === "imageText" ? removed.block.paragraphs : [],
    ).toEqual([[{ text: "Två." }], []]);
  });

  it("records an uploaded picture on its own block, as a banner does", () => {
    const entries = editorBlocks([
      {
        type: "imageText",
        mediaFileId: "",
        alt: "",
        side: "left",
        paragraphs: [],
      },
      { type: "banner", mediaFileId: "", alt: "", heading: "" },
    ]);
    const [imageText, banner] = idsOf(entries);
    const stored = withUploadedPicture(
      withUploadedPicture(entries, banner ?? "", "file-2"),
      imageText ?? "",
      "file-1",
    );
    expect(stored.map((entry) => entry.block)).toEqual([
      {
        type: "imageText",
        mediaFileId: "file-1",
        alt: "",
        side: "left",
        paragraphs: [],
      },
      { type: "banner", mediaFileId: "file-2", alt: "", heading: "" },
    ]);
  });
});

describe("a block of a plugin that is serving", () => {
  const SCHEDULE: PluginBlockDeclaration = {
    type: "laundry/schedule",
    pluginId: "laundry",
    labelKey: "blocks.schedule.label",
    icon: "calendar",
    category: "association",
    fields: [
      {
        key: "heading",
        labelKey: "blocks.schedule.heading",
        type: "text",
        required: true,
      },
      {
        key: "days",
        labelKey: "blocks.schedule.days",
        type: "number",
        required: false,
        integer: true,
        default: 7,
      },
    ],
  };
  const registry = editorRegistry([SCHEDULE]);

  it("is registered while its plugin serves, and not otherwise", () => {
    const block: PageBlock = { type: "laundry/schedule", settings: {} };

    expect(registry.definition(block.type)).toBeDefined();
    expect(PAGE_BLOCKS.definition(block.type)).toBeUndefined();
    expect(pluginBlockOf(block, [SCHEDULE])).toBe(SCHEDULE);
    expect(pluginBlockOf({ type: "paragraph", runs: [] }, [SCHEDULE])).toBe(
      undefined,
    );
  });

  it("starts with its declared defaults", () => {
    expect(newPluginBlock(SCHEDULE).block).toEqual({
      type: "laundry/schedule",
      settings: { days: 7 },
    });
  });

  it("changes one setting, or takes it out", () => {
    const block: PageBlock = {
      type: "laundry/schedule",
      settings: { days: 7 },
    };

    const named = withPluginSetting(block, "heading", "Tvättstugan");
    expect(pluginSettingsOf(named)).toEqual({
      days: 7,
      heading: "Tvättstugan",
    });
    expect(
      pluginSettingsOf(withPluginSetting(named, "days", undefined)),
    ).toEqual({ heading: "Tvättstugan" });
    expect(
      pluginSettingsOf({ type: "laundry/schedule", settings: [] }),
    ).toEqual({});
  });

  it("is sent once its required settings are answered, and kept as stored while its plugin is off", () => {
    const unanswered: PageBlock = { type: "laundry/schedule", settings: {} };
    const answered: PageBlock = {
      type: "laundry/schedule",
      settings: { heading: "Tvättstugan" },
    };

    expect(submittableBlocks([unanswered, answered], registry)).toEqual({
      blocks: [answered],
      positions: [1],
    });
    // Without the plugin, nothing here can tell what it needs: sent as is.
    expect(submittableBlocks([unanswered]).blocks).toEqual([unanswered]);
  });

  it("holds back a save over a stored block its plugin now asks more of", () => {
    // Set up before an upgrade that added a required setting.
    const stored = editorBlocks([
      TEXT,
      { type: "laundry/schedule", settings: { days: 3 } },
    ]);
    const added = [...stored, newPluginBlock(SCHEDULE)];

    // Before the plugin's declaration is known the block is sent as it is.
    expect(unfinishedStoredBlocks(added, editorRegistry([]))).toEqual([]);
    expect(submittableBlocks(blocksOf(stored)).blocks).toHaveLength(2);
    // Once it is, the stored block is named, so the save is refused rather
    // than sent without it; the one the board has only just added is not.
    expect(unfinishedStoredBlocks(added, registry)).toEqual([1]);

    const answered = updateBlock(
      added,
      (added[1] as EditorBlock).id,
      withPluginSetting(
        (added[1] as EditorBlock).block,
        "heading",
        "Tvättstugan",
      ),
    );
    expect(unfinishedStoredBlocks(answered, registry)).toEqual([]);
    // A core block emptied is one the board meant to leave out.
    expect(
      unfinishedStoredBlocks(
        editorBlocks([{ type: "paragraph", runs: [] }]),
        registry,
      ),
    ).toEqual([]);
  });

  it("counts a block added and saved as stored from then on", () => {
    const entries = [newPluginBlock(SCHEDULE)];

    expect(entries[0]?.stored).toBe(false);
    const saved = storedAs(entries, new Set([idsOf(entries)[0] as string]));
    expect(saved[0]?.stored).toBe(true);
    expect(idsOf(saved)).toEqual(idsOf(entries));
    // Emptied afterwards, it is held back like one read with the page.
    const emptied = updateBlock(saved, (saved[0] as EditorBlock).id, {
      type: "laundry/schedule",
      settings: { days: 7 },
    } as PageBlock);
    expect(unfinishedStoredBlocks(emptied, registry)).toEqual([0]);
  });
});

describe("unfinished work", () => {
  const PICTURE = { type: "image", mediaFileId: "", alt: "" } as PageBlock;
  const PARAGRAPH = (text: string) =>
    ({ type: "paragraph", runs: text === "" ? [] : [{ text }] }) as PageBlock;

  it("is words written on a block a save leaves out", () => {
    const captioned = { ...PICTURE, caption: "Sommarfesten" } as PageBlock;

    expect(unfinishedWork([captioned])).toEqual([captioned]);
    expect(unfinishedWork([PICTURE])).toEqual([]);
    expect(unfinishedWork([PARAGRAPH(""), PARAGRAPH("Hej")])).toEqual([]);
  });

  it("reads a paragraph typed in and deleted again as one never written", () => {
    expect(
      unfinishedWork([
        { type: "paragraph", runs: [{ text: "" }] } as PageBlock,
      ]),
    ).toEqual([]);
  });

  it("is found inside a column, whether or not the columns block is sent", () => {
    const captioned = { ...PICTURE, caption: "Sommarfesten" } as PageBlock;
    const columns = (first: PageBlock[]) =>
      ({
        type: "columns",
        columns: [{ blocks: first }, { blocks: [] }],
      }) as PageBlock;

    expect(unfinishedWork([columns([PARAGRAPH("Hej"), captioned])])).toEqual([
      captioned,
    ]);
    expect(unfinishedWork([columns([captioned])])).toEqual([captioned]);
    expect(unfinishedWork([columns([PICTURE, PARAGRAPH("")])])).toEqual([]);
  });
});

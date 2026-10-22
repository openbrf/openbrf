import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { PAGE_CONTENT_LIMITS } from "../page-content-limits.ts";
import { PAGE_BLOCKS } from "./registry.ts";

/**
 * The four blocks that arrange a page rather than write it: a button, a
 * banner, a picture beside text, and columns.
 *
 * Held to the same two promises as every other block - the write path refuses
 * what it will not publish and says where, and the read path keeps what it can
 * vouch for and drops the rest - and to the ones these add: a picture is
 * described, a button leads somewhere this instance can name, and a column
 * never holds a layout block.
 */

const blocks = z.strictObject({
  blocks: z.array(PAGE_BLOCKS.schema(z)),
});

/**
 * The paths a body is refused at, once each, or nothing when it is accepted.
 *
 * Once each because an address is refused by its pattern and by the rule
 * behind it both, and the screen names a place, not a count.
 *
 * A value wrong at a block's own root - a style, a side, a count of columns -
 * fails both halves of the registry's union, and zod then names the block
 * rather than the field (see unregisteredSchema in registry.ts). That is still
 * the block the editor points the board at.
 */
function refusals(...body: unknown[]): string[] {
  const parsed = blocks.safeParse({ blocks: body });
  return parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
}

/**
 * Whether a body is refused, and refused somewhere in its first block.
 *
 * For a value wrong at the block's root, where zod's own choice between
 * naming the block and naming the field is not this platform's promise -
 * naming the block is, because that is what the editor turns into "block 1".
 */
function refusedInFirstBlock(...body: unknown[]): boolean {
  const paths = refusals(...body);
  return (
    paths.length > 0 &&
    paths.every((path) => path === "blocks.0" || path.startsWith("blocks.0."))
  );
}

const BUTTON = {
  type: "button",
  label: "Read the bylaws",
  target: { kind: "page", pageId: "page-1" },
  style: "primary",
} as const;

const BANNER = {
  type: "banner",
  mediaFileId: "file-1",
  alt: "The courtyard in May, with the birch in leaf",
  heading: "Welcome to Brf Björken",
} as const;

const IMAGE_TEXT = {
  type: "imageText",
  mediaFileId: "file-2",
  alt: "The laundry room",
  side: "right",
  paragraphs: [[{ text: "Book a time on the board by the door." }]],
} as const;

const PARAGRAPH = {
  type: "paragraph",
  runs: [{ text: "The cellar is cleared on Saturday." }],
} as const;

function columns(...lists: unknown[][]): unknown {
  return { type: "columns", columns: lists.map((list) => ({ blocks: list })) };
}

describe("a button", () => {
  it("leads to a page, a built-in page among them, or an https address", () => {
    expect(refusals(BUTTON)).toEqual([]);
    expect(
      refusals({
        ...BUTTON,
        target: { kind: "page", pageId: "built-in-calendar" },
      }),
    ).toEqual([]);
    expect(
      refusals({
        ...BUTTON,
        target: { kind: "url", url: "https://exempel.se/stadgar" },
        style: "secondary",
      }),
    ).toEqual([]);
  });

  it("refuses an address that is not https, and says where", () => {
    for (const url of [
      "http://exempel.se",
      "javascript:alert(1)",
      "/stadgar",
      "//exempel.se",
      "mailto:styrelsen@exempel.se",
    ]) {
      expect(refusals({ ...BUTTON, target: { kind: "url", url } })).toEqual([
        "blocks.0.target.url",
      ]);
    }
  });

  it("refuses a label of nothing but spaces, a style and a kind of destination it does not know", () => {
    expect(refusals({ ...BUTTON, label: "   " })).toEqual(["blocks.0.label"]);
    expect(refusedInFirstBlock({ ...BUTTON, style: "danger" })).toBe(true);
    // A built-in page is a page, named by its id. The key it was once named by
    // is not a second way to say so.
    expect(
      refusedInFirstBlock({
        ...BUTTON,
        target: { kind: "builtIn", page: "calendar" },
      }),
    ).toBe(true);
    expect(
      refusals({
        ...BUTTON,
        label: "x".repeat(PAGE_CONTENT_LIMITS.buttonLabel + 1),
      }),
    ).toEqual(["blocks.0.label"]);
  });

  it("is dropped on read when its destination or its style cannot be vouched for", () => {
    expect(PAGE_BLOCKS.read(BUTTON)).toEqual(BUTTON);
    expect(
      PAGE_BLOCKS.read({
        ...BUTTON,
        target: { kind: "url", url: "http://exempel.se" },
      }),
    ).toBeNull();
    expect(
      PAGE_BLOCKS.read({
        ...BUTTON,
        target: { kind: "builtIn", page: "news" },
      }),
    ).toBeNull();
    expect(PAGE_BLOCKS.read({ ...BUTTON, style: "danger" })).toBeNull();
    expect(PAGE_BLOCKS.read({ ...BUTTON, label: " " })).toBeNull();
  });

  it("publishes its label as words and an address as an address", () => {
    const url = "https://exempel.se/19811218-9876";
    expect(
      PAGE_BLOCKS.text({ ...BUTTON, target: { kind: "url", url } }),
    ).toEqual({
      words: "Read the bylaws",
      addresses: [url],
      unreadableAddress: false,
    });
    expect(PAGE_BLOCKS.text(BUTTON).addresses).toEqual([]);
    expect(PAGE_BLOCKS.linkTargets(BUTTON)).toEqual([BUTTON.target]);
  });

  it("is sent once it has a label, so a missing destination is refused rather than lost", () => {
    expect(
      PAGE_BLOCKS.ready({ ...BUTTON, target: { kind: "page", pageId: "" } }),
    ).toBe(true);
    expect(
      refusals({ ...BUTTON, target: { kind: "page", pageId: "" } }),
    ).toEqual(["blocks.0.target.pageId"]);
    expect(PAGE_BLOCKS.ready({ ...BUTTON, label: "" })).toBe(false);
  });
});

describe("a banner", () => {
  it("requires a described picture and a heading", () => {
    expect(refusals(BANNER)).toEqual([]);
    expect(refusals({ ...BANNER, alt: "" })).toEqual(["blocks.0.alt"]);
    expect(refusals({ ...BANNER, alt: "  " })).toEqual(["blocks.0.alt"]);
    expect(refusals({ ...BANNER, heading: "" })).toEqual(["blocks.0.heading"]);
    expect(refusals({ ...BANNER, mediaFileId: "" })).toEqual([
      "blocks.0.mediaFileId",
    ]);
    expect(
      refusals({
        ...BANNER,
        text: "x".repeat(PAGE_CONTENT_LIMITS.bannerText + 1),
      }),
    ).toEqual(["blocks.0.text"]);
  });

  it("carries a button under the same rules as a button block", () => {
    const button = { label: "Contact the board", target: BUTTON.target };
    expect(refusals({ ...BANNER, button })).toEqual([]);
    expect(
      refusals({
        ...BANNER,
        button: { ...button, target: { kind: "url", url: "http://x.se" } },
      }),
    ).toEqual(["blocks.0.button.target.url"]);
    expect(PAGE_BLOCKS.linkTargets({ ...BANNER, button })).toEqual([
      BUTTON.target,
    ]);
  });

  it("is dropped on read without its description, and keeps itself without an unreadable button", () => {
    expect(PAGE_BLOCKS.read({ ...BANNER, alt: "" })).toBeNull();
    expect(PAGE_BLOCKS.read({ ...BANNER, heading: 4 })).toBeNull();
    expect(
      PAGE_BLOCKS.read({
        ...BANNER,
        button: { label: "Go", target: { kind: "url", url: "ftp://x" } },
      }),
    ).toEqual(BANNER);
  });

  it("stores no empty text, and is scanned in every word it publishes", () => {
    expect(PAGE_BLOCKS.normalize({ ...BANNER, text: "  " })).toEqual(BANNER);
    const text = PAGE_BLOCKS.text({
      ...BANNER,
      text: "Short text",
      button: {
        label: "Go",
        target: { kind: "url", url: "https://exempel.se" },
      },
    });
    expect(text.words).toBe(`${BANNER.alt} ${BANNER.heading} Short text Go`);
    expect(text.addresses).toEqual(["https://exempel.se"]);
    expect(PAGE_BLOCKS.media(BANNER)).toEqual(["file-1"]);
  });

  it("is sent once a picture is chosen, without a button nobody labelled", () => {
    const banner = {
      ...BANNER,
      button: { label: "", target: { kind: "page", pageId: "" } },
    };
    expect(PAGE_BLOCKS.ready(banner)).toBe(true);
    expect(PAGE_BLOCKS.sendable(banner)).toEqual(BANNER);
    expect(PAGE_BLOCKS.ready({ ...BANNER, mediaFileId: "" })).toBe(false);
  });
});

describe("a picture beside text", () => {
  it("requires a description and a side", () => {
    expect(refusals(IMAGE_TEXT)).toEqual([]);
    expect(refusals({ ...IMAGE_TEXT, alt: "" })).toEqual(["blocks.0.alt"]);
    expect(refusedInFirstBlock({ ...IMAGE_TEXT, side: "top" })).toBe(true);
    expect(
      refusals({
        ...IMAGE_TEXT,
        paragraphs: [[{ text: "x", link: "javascript:alert(1)" }]],
      }),
    ).toEqual(["blocks.0.paragraphs.0.0.link"]);
  });

  it("keeps the picture while nothing is written beside it", () => {
    const empty = { ...IMAGE_TEXT, paragraphs: [[{ text: "" }]] };
    expect(PAGE_BLOCKS.normalize(empty)).toEqual({
      ...IMAGE_TEXT,
      paragraphs: [],
    });
    expect(PAGE_BLOCKS.read({ ...IMAGE_TEXT, paragraphs: "x" })).toEqual({
      ...IMAGE_TEXT,
      paragraphs: [],
    });
  });

  it("is scanned paragraph by paragraph, never across the gap between two", () => {
    const text = PAGE_BLOCKS.text({
      ...IMAGE_TEXT,
      paragraphs: [[{ text: "19811218" }], [{ text: "-9876" }]],
    });
    expect(text.words).toBe("The laundry room 19811218 -9876");
    expect(PAGE_BLOCKS.media(IMAGE_TEXT)).toEqual(["file-2"]);
  });
});

describe("columns", () => {
  it("are two or three", () => {
    expect(refusals(columns([PARAGRAPH], []))).toEqual([]);
    expect(refusals(columns([PARAGRAPH], [], [BUTTON]))).toEqual([]);
    expect(refusedInFirstBlock(columns([PARAGRAPH]))).toBe(true);
    expect(refusedInFirstBlock(columns([PARAGRAPH], [], [], []))).toBe(true);
  });

  it("refuse columns, layout blocks and per-page blocks inside a column", () => {
    for (const nested of [
      columns([PARAGRAPH], [PARAGRAPH]),
      BANNER,
      IMAGE_TEXT,
      { type: "contactForm" },
      { type: "newsTeaser", count: 3 },
      { type: "example-plugin/poll", question: "Paint?" },
    ]) {
      expect(refusedInFirstBlock(columns([PARAGRAPH], [nested]))).toBe(true);
    }
  });

  it("keep the path into a block inside a column", () => {
    expect(
      refusals(
        columns(
          [PARAGRAPH],
          [{ ...BUTTON, target: { kind: "url", url: "http://x.se" } }],
        ),
      ),
    ).toEqual(["blocks.0.columns.1.blocks.0.target.url"]);
  });

  it("hold no more blocks than a column may", () => {
    const full = Array.from(
      { length: PAGE_CONTENT_LIMITS.columnBlocks + 1 },
      () => PARAGRAPH,
    );
    expect(refusedInFirstBlock(columns(full, []))).toBe(true);
  });

  it("drop on read what may not sit in them, and keep the rest in place", () => {
    expect(
      PAGE_BLOCKS.read(
        columns(
          [PARAGRAPH, columns([PARAGRAPH], [PARAGRAPH]), BANNER],
          [{ type: "nobodyKnows" }, BUTTON],
        ),
      ),
    ).toEqual(columns([PARAGRAPH], [BUTTON]));
  });

  it("keep a column the board left empty, and are dropped when every one is", () => {
    expect(PAGE_BLOCKS.read(columns([], [PARAGRAPH], []))).toEqual(
      columns([], [PARAGRAPH], []),
    );
    expect(PAGE_BLOCKS.read(columns([], []))).toBeNull();
    expect(PAGE_BLOCKS.read(columns([PARAGRAPH]))).toBeNull();
    expect(
      PAGE_BLOCKS.normalize(
        columns([{ type: "paragraph", runs: [{ text: "" }] }], []),
      ),
    ).toBeNull();
  });

  it("are scanned, checked and resolved through every block inside them", () => {
    const image = { type: "image", mediaFileId: "file-3", alt: "Stairs" };
    const block = columns([PARAGRAPH, image], [BUTTON]);
    expect(PAGE_BLOCKS.text(block).words).toBe(
      "The cellar is cleared on Saturday. Stairs Read the bylaws",
    );
    expect(PAGE_BLOCKS.media(block)).toEqual(["file-3"]);
    expect(PAGE_BLOCKS.linkTargets(block)).toEqual([BUTTON.target]);
  });

  it("are sent without the blocks inside them that are not finished", () => {
    const unfinished = columns(
      [PARAGRAPH, { type: "image", mediaFileId: "", alt: "" }],
      [{ type: "paragraph", runs: [] }],
    );
    expect(PAGE_BLOCKS.ready(unfinished)).toBe(true);
    expect(PAGE_BLOCKS.sendable(unfinished)).toEqual(columns([PARAGRAPH], []));
    expect(PAGE_BLOCKS.ready(columns([], []))).toBe(false);
  });
});

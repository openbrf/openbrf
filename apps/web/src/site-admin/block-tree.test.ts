import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
import { describe, expect, it } from "vite-plus/test";

import type { PageBlock, ParagraphBlock } from "../api/site";
import {
  duplicate,
  moveTo,
  placeOf,
  placesFor,
  resolveDrop,
  takeOut,
  undoArrangement,
} from "./block-tree";
import { blocksOf, type EditorBlock, editorBlocks } from "./page-blocks";

/**
 * Moving blocks about a page and into and out of its columns, without a
 * pointer, a keyboard or a rendered page.
 *
 * Dragging, the arrow keys, duplicating and taking a change back all come down
 * to these functions, so what they promise - that a block lands where it was
 * dropped, that a column only takes what may sit in one, and that taking a
 * change back restores the arrangement without touching the words - is
 * settled here.
 */

const text = (words: string): ParagraphBlock => ({
  type: "paragraph",
  runs: [{ text: words }],
});

const BANNER: PageBlock = {
  type: "banner",
  mediaFileId: "file-1",
  alt: "Gården",
  heading: "Välkommen",
};

/** A page: a paragraph, two columns holding one paragraph each, a paragraph. */
function page(): EditorBlock[] {
  return editorBlocks([
    text("Först."),
    {
      type: "columns",
      columns: [{ blocks: [text("Vänster.")] }, { blocks: [text("Höger.")] }],
    },
    text("Sist."),
  ]);
}

/** Every paragraph's words, in reading order, with the columns in brackets. */
function reading(entries: readonly EditorBlock[]): string[] {
  return blocksOf(entries).flatMap((block): string[] => {
    if (block.type === "paragraph") {
      return [(block as { runs: { text: string }[] }).runs[0]?.text ?? ""];
    }
    if (block.type === "columns") {
      return (block as { columns: { blocks: PageBlock[] }[] }).columns.map(
        (column) =>
          `[${column.blocks
            .map(
              (one) => (one as { runs?: { text: string }[] }).runs?.[0]?.text,
            )
            .join(" ")}]`,
      );
    }
    return [block.type];
  });
}

/** The first block in a column of the page's columns block. */
function idOf(entries: readonly EditorBlock[], column: number): string {
  const columns = entries.find((entry) => entry.block.type === "columns");
  return columns?.nested?.[column]?.[0] ?? "";
}

describe("a place on the page", () => {
  it("is found for a block on the page and for one in a column", () => {
    const entries = page();
    expect(placeOf(entries, entries[2]?.id ?? "")).toEqual({
      list: "page",
      at: 2,
    });
    expect(placeOf(entries, idOf(entries, 1))).toEqual({
      list: "column",
      parent: entries[1]?.id,
      column: 1,
      at: 0,
    });
  });
});

describe("moving a block", () => {
  it("moves a paragraph into a column, and out of one", () => {
    const entries = page();
    const columns = entries[1]?.id ?? "";

    const into = moveTo(entries, entries[0]?.id ?? "", {
      list: "column",
      parent: columns,
      column: 0,
      at: 1,
    });
    expect(reading(into)).toEqual(["[Vänster. Först.]", "[Höger.]", "Sist."]);

    const out = moveTo(into, idOf(into, 1), { list: "page", at: 2 });
    expect(reading(out)).toEqual([
      "[Vänster. Först.]",
      "[]",
      "Sist.",
      "Höger.",
    ]);
  });

  it("keeps a block that may not sit in a column out of one", () => {
    const entries = [...page(), ...editorBlocks([BANNER])];
    const moved = moveTo(entries, entries[3]?.id ?? "", {
      list: "column",
      parent: entries[1]?.id ?? "",
      column: 0,
      at: 0,
    });
    expect(blocksOf(moved)).toEqual(blocksOf(entries));
  });

  it("does not put a block into a full column", () => {
    const full = editorBlocks([
      text("Ute."),
      {
        type: "columns",
        columns: [
          {
            blocks: Array.from(
              { length: PAGE_CONTENT_LIMITS.columnBlocks },
              () => text("I."),
            ),
          },
          { blocks: [] },
        ],
      },
    ]);
    const { places } = placesFor(full, full[0]?.id ?? "");
    expect(
      places.filter((place) => place.list === "column" && place.column === 0),
    ).toEqual([]);
    expect(
      places.filter((place) => place.list === "column" && place.column === 1),
    ).toHaveLength(1);
  });
});

describe("the places the keyboard steps through", () => {
  it("are every gap of the page and of each column, in reading order", () => {
    const entries = page();
    const columns = entries[1]?.id ?? "";
    const { places, current } = placesFor(entries, entries[2]?.id ?? "");

    expect(places).toEqual([
      { list: "page", at: 0 },
      { list: "page", at: 1 },
      { list: "column", parent: columns, column: 0, at: 0 },
      { list: "column", parent: columns, column: 0, at: 1 },
      { list: "column", parent: columns, column: 1, at: 0 },
      { list: "column", parent: columns, column: 1, at: 1 },
      { list: "page", at: 2 },
    ]);
    // The paragraph stands at the end, which is the last of them.
    expect(current).toBe(6);
  });

  it("leave out the columns for a block that may not sit in one", () => {
    const entries = [...page(), ...editorBlocks([BANNER])];
    const { places } = placesFor(entries, entries[3]?.id ?? "");
    expect(places.every((place) => place.list === "page")).toBe(true);
    expect(places).toHaveLength(4);
  });

  it("never put a columns block inside itself", () => {
    const entries = page();
    const { places, current } = placesFor(entries, entries[1]?.id ?? "");
    expect(places).toEqual([
      { list: "page", at: 0 },
      { list: "page", at: 1 },
      { list: "page", at: 2 },
    ]);
    expect(current).toBe(1);
  });
});

describe("duplicating a block", () => {
  it("puts a copy with identities of its own straight after it", () => {
    const entries = page();
    const result = duplicate(entries, entries[1]?.id ?? "");
    expect(result).toBeDefined();
    const after = result?.entries ?? [];

    expect(blocksOf(after)[2]).toEqual(blocksOf(after)[1]);
    expect(after[2]?.id).toBe(result?.id);
    expect(after[2]?.id).not.toBe(after[1]?.id);
    expect(after[2]?.stored).toBe(false);
    // Nothing inside the copy shares an identity with the original.
    const original = new Set(after[1]?.nested?.flat());
    expect(after[2]?.nested?.flat().some((id) => original.has(id))).toBe(false);
  });

  it("copies a block in a column within its column", () => {
    const entries = page();
    const result = duplicate(entries, idOf(entries, 0));
    expect(reading(result?.entries ?? [])).toEqual([
      "Först.",
      "[Vänster. Vänster.]",
      "[Höger.]",
      "Sist.",
    ]);
  });

  it("does nothing on a page with no room for another block", () => {
    const entries = editorBlocks(
      Array.from({ length: PAGE_CONTENT_LIMITS.blocks }, () => text("Full.")),
    );
    expect(duplicate(entries, entries[0]?.id ?? "")).toBeUndefined();
  });
});

describe("taking a change back", () => {
  it("puts a removed block back where it stood, in its column", () => {
    const entries = page();
    const out = takeOut(entries, idOf(entries, 1));
    expect(out).toBeDefined();
    const restored = undoArrangement(out?.entries ?? [], {
      kind: "putBack",
      entry: out?.taken as EditorBlock,
      place: out?.from as never,
    });
    expect(blocksOf(restored)).toEqual(blocksOf(entries));
  });

  it("moves a moved block back, keeping the words written since", () => {
    const entries = page();
    const id = entries[0]?.id ?? "";
    const from = placeOf(entries, id);
    const moved = moveTo(entries, id, { list: "page", at: 2 });
    // Written in after the move, in the block that did not move.
    const written = moved.map((entry) =>
      entry.block.type === "paragraph" && entry.id !== id
        ? { ...entry, block: text("Sist, ändrad.") }
        : entry,
    );
    const back = undoArrangement(written, {
      kind: "moveBack",
      id,
      place: from as never,
    });
    expect(reading(back)).toEqual([
      "Först.",
      "[Vänster.]",
      "[Höger.]",
      "Sist, ändrad.",
    ]);
  });

  it("takes an added block out again", () => {
    const entries = page();
    const copied = duplicate(entries, entries[0]?.id ?? "");
    const back = undoArrangement(copied?.entries ?? [], {
      kind: "takeOut",
      id: copied?.id ?? "",
    });
    expect(blocksOf(back)).toEqual(blocksOf(entries));
  });
});

describe("a drop", () => {
  it("lands before or after the block it is over", () => {
    const entries = page();
    const dragged = entries[2]?.id ?? "";
    expect(
      resolveDrop(entries, dragged, {
        id: entries[0]?.id ?? "",
        edge: "before",
      })?.place,
    ).toEqual({ list: "page", at: 0 });
    expect(
      resolveDrop(entries, dragged, { id: idOf(entries, 1), edge: "after" })
        ?.place,
    ).toEqual({
      list: "column",
      parent: entries[1]?.id,
      column: 1,
      at: 1,
    });
  });

  it("lands at the end of an empty column", () => {
    const entries = editorBlocks([
      text("Ute."),
      { type: "columns", columns: [{ blocks: [] }, { blocks: [] }] },
    ]);
    expect(
      resolveDrop(entries, entries[0]?.id ?? "", {
        parent: entries[1]?.id ?? "",
        column: 1,
      })?.place,
    ).toEqual({ list: "column", parent: entries[1]?.id, column: 1, at: 0 });
  });

  it("lands beside the columns for a block that may not sit in one", () => {
    const entries = [...editorBlocks([BANNER]), ...page()];
    const result = resolveDrop(entries, entries[0]?.id ?? "", {
      id: idOf(entries, 0),
      edge: "after",
    });
    expect(result?.place).toEqual({ list: "page", at: 2 });
    expect(result?.target).toEqual({ id: entries[2]?.id, edge: "after" });
  });

  it("changes nothing where the block already stands", () => {
    const entries = page();
    expect(
      resolveDrop(entries, entries[2]?.id ?? "", {
        id: entries[1]?.id ?? "",
        edge: "after",
      }),
    ).toBeNull();
    expect(
      resolveDrop(entries, entries[2]?.id ?? "", {
        id: entries[2]?.id ?? "",
        edge: "before",
      }),
    ).toBeNull();
  });
});

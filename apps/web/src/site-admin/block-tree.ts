import { NESTED_BLOCKS, PAGE_CONTENT_LIMITS } from "@openbrf/shared";

import type { ColumnsBlock, NestedBlock, PageBlock } from "../api/site";
import {
  columnsEntry,
  columnsOf,
  type EditorBlock,
  newBlockWith,
} from "./page-blocks";

/**
 * Where the blocks of a page stand, and moving them.
 *
 * A page is a list of blocks, and a columns block on it holds a list of blocks
 * in each column: two levels and never three. Dragging a block, moving it from
 * the keyboard, duplicating it, removing it and taking that back are all the
 * same few acts on that shape - take a block out of its place, put one in at a
 * place - so they are written once here, as pure functions over the editor's
 * entries, and the screen only decides which place.
 *
 * A place names a column by the identity of the columns block it is in rather
 * than by that block's position, so a place read before a move is still the
 * same place after it.
 */

/** Where a block stands, or where one would be put. */
export type BlockPlace =
  | { list: "page"; at: number }
  | { list: "column"; parent: string; column: number; at: number };

/** The block types a column may hold. */
const NESTABLE: ReadonlySet<string> = new Set(
  NESTED_BLOCKS.map((definition) => definition.type),
);

/** Whether a block may sit in a column. */
export function isNestable(block: PageBlock): block is NestedBlock {
  return NESTABLE.has(block.type);
}

/** Whether two places are the same place. */
export function samePlace(a: BlockPlace, b: BlockPlace): boolean {
  if (a.list === "page" || b.list === "page") {
    return a.list === b.list && a.at === b.at;
  }
  return a.parent === b.parent && a.column === b.column && a.at === b.at;
}

/** Where the block with this identity stands, if it is on the page at all. */
export function placeOf(
  entries: readonly EditorBlock[],
  id: string,
): BlockPlace | undefined {
  for (const [at, entry] of entries.entries()) {
    if (entry.id === id) {
      return { list: "page", at };
    }
    if (entry.block.type === "columns") {
      for (const [column, ids] of (entry.nested ?? []).entries()) {
        const position = ids.indexOf(id);
        if (position !== -1) {
          return { list: "column", parent: entry.id, column, at: position };
        }
      }
    }
  }
  return undefined;
}

/**
 * The block with this identity, as an entry of its own.
 *
 * A block in a column has no entry of its own in the editor's list, only an
 * identity beside it; it is given one here, which is the shape a block has
 * while it is being moved.
 */
export function entryOf(
  entries: readonly EditorBlock[],
  id: string,
): EditorBlock | undefined {
  const place = placeOf(entries, id);
  if (place === undefined) {
    return undefined;
  }
  if (place.list === "page") {
    return entries[place.at];
  }
  const parent = entries.find((entry) => entry.id === place.parent);
  const block = (parent?.block as ColumnsBlock | undefined)?.columns[
    place.column
  ]?.blocks[place.at];
  return block === undefined ? undefined : { id, block, stored: false };
}

/** The columns block a place in a column belongs to, as it stands now. */
function parentOf(
  entries: readonly EditorBlock[],
  place: Extract<BlockPlace, { list: "column" }>,
): { at: number; entry: EditorBlock } | undefined {
  const at = entries.findIndex(
    (entry) => entry.id === place.parent && entry.block.type === "columns",
  );
  const entry = entries[at];
  return entry === undefined ? undefined : { at, entry };
}

/**
 * The page with one block's content replaced, wherever it stands, keeping its
 * identity and everything else as it is.
 */
export function updateBlock(
  entries: readonly EditorBlock[],
  id: string,
  block: PageBlock,
): EditorBlock[] {
  const place = placeOf(entries, id);
  if (place === undefined) {
    return [...entries];
  }
  if (place.list === "page") {
    return entries.map((entry, at) =>
      at === place.at ? { ...entry, block } : entry,
    );
  }
  const parent = parentOf(entries, place);
  if (parent === undefined || !isNestable(block)) {
    return [...entries];
  }
  const { columns, ids } = columnsOf(parent.entry);
  const column = columns[place.column];
  if (column !== undefined) {
    column[place.at] = block;
  }
  return entries.map((entry, at) =>
    at === parent.at ? columnsEntry(parent.entry, columns, ids) : entry,
  );
}

/**
 * Takes the block with this identity out of the page, saying where it was.
 *
 * The place is the one it would be put back at, so taking a block out and
 * putting it in at the place it was taken from leaves the page as it was.
 */
export function takeOut(
  entries: readonly EditorBlock[],
  id: string,
):
  { entries: EditorBlock[]; taken: EditorBlock; from: BlockPlace } | undefined {
  const from = placeOf(entries, id);
  const taken = entryOf(entries, id);
  if (from === undefined || taken === undefined) {
    return undefined;
  }
  if (from.list === "page") {
    return {
      entries: entries.filter((_, at) => at !== from.at),
      taken,
      from,
    };
  }
  const parent = parentOf(entries, from);
  if (parent === undefined) {
    return undefined;
  }
  const { columns, ids } = columnsOf(parent.entry);
  columns[from.column]?.splice(from.at, 1);
  ids[from.column]?.splice(from.at, 1);
  return {
    entries: entries.map((entry, at) =>
      at === parent.at ? columnsEntry(parent.entry, columns, ids) : entry,
    ),
    taken,
    from,
  };
}

/**
 * Whether a block may be put in at a place: a column holds only the blocks
 * that may sit in one, and neither a column nor the page holds more than the
 * write path accepts.
 */
export function mayStandAt(
  entries: readonly EditorBlock[],
  block: PageBlock,
  place: BlockPlace,
): boolean {
  if (place.list === "page") {
    return (
      place.at >= 0 &&
      place.at <= entries.length &&
      entries.length < PAGE_CONTENT_LIMITS.blocks
    );
  }
  const parent = parentOf(entries, place);
  const column = (parent?.entry.block as ColumnsBlock | undefined)?.columns[
    place.column
  ];
  return (
    isNestable(block) &&
    column !== undefined &&
    place.at >= 0 &&
    place.at <= column.blocks.length &&
    column.blocks.length < PAGE_CONTENT_LIMITS.columnBlocks
  );
}

/**
 * Puts a block in at a place, or leaves the page as it is where it may not
 * stand there.
 */
export function putIn(
  entries: readonly EditorBlock[],
  place: BlockPlace,
  entry: EditorBlock,
): EditorBlock[] {
  if (!mayStandAt(entries, entry.block, place)) {
    return [...entries];
  }
  if (place.list === "page") {
    return [...entries.slice(0, place.at), entry, ...entries.slice(place.at)];
  }
  const parent = parentOf(entries, place);
  if (parent === undefined) {
    return [...entries];
  }
  const { columns, ids } = columnsOf(parent.entry);
  columns[place.column]?.splice(place.at, 0, entry.block as NestedBlock);
  ids[place.column]?.splice(place.at, 0, entry.id);
  return entries.map((one, at) =>
    at === parent.at ? columnsEntry(parent.entry, columns, ids) : one,
  );
}

/**
 * Moves a block to a place, read on the page without it.
 *
 * Read that way because that is what a place means to somebody moving a
 * block: "before the third block" names the third block of the others, not
 * a position the block itself is still holding. A block that may not stand at
 * the place stays where it was.
 */
export function moveTo(
  entries: readonly EditorBlock[],
  id: string,
  place: BlockPlace,
): EditorBlock[] {
  const out = takeOut(entries, id);
  if (out === undefined || !mayStandAt(out.entries, out.taken.block, place)) {
    return [...entries];
  }
  return putIn(out.entries, place, out.taken);
}

/**
 * Every place a block could be moved to, in the order a person reads the page.
 *
 * The gaps of the page from the top, and inside each columns block, between
 * the gap before it and the gap after it, the gaps of its columns from the
 * first - for a block that may sit in a column, and in a column that has room.
 * Read on the page without the block, as moveTo reads them, so the block's own
 * place is one of them: it is where it stands now.
 *
 * What moving a block from the keyboard steps through, one place per arrow
 * key, so a person without a pointer reaches every place a drag could drop it.
 */
export function placesFor(
  entries: readonly EditorBlock[],
  id: string,
): { places: BlockPlace[]; current: number } {
  const out = takeOut(entries, id);
  if (out === undefined) {
    return { places: [], current: -1 };
  }
  const places: BlockPlace[] = [];
  const others = out.entries;
  const pageHasRoom = mayStandAt(others, out.taken.block, {
    list: "page",
    at: 0,
  });
  others.forEach((entry, at) => {
    if (pageHasRoom) {
      places.push({ list: "page", at });
    }
    if (entry.block.type !== "columns" || !isNestable(out.taken.block)) {
      return;
    }
    (entry.block as ColumnsBlock).columns.forEach((column, columnAt) => {
      for (let position = 0; position <= column.blocks.length; position += 1) {
        const place: BlockPlace = {
          list: "column",
          parent: entry.id,
          column: columnAt,
          at: position,
        };
        if (mayStandAt(others, out.taken.block, place)) {
          places.push(place);
        }
      }
    });
  });
  if (pageHasRoom) {
    places.push({ list: "page", at: others.length });
  }
  return {
    places,
    current: places.findIndex((place) => samePlace(place, out.from)),
  };
}

/**
 * The same page with a copy of a block straight after it, and the copy's
 * identity; or undefined where the list it is in has no room for another.
 *
 * The copy is a block of its own from the start: its own identity, and its
 * own for everything inside it, and not yet stored.
 */
export function duplicate(
  entries: readonly EditorBlock[],
  id: string,
): { entries: EditorBlock[]; id: string } | undefined {
  const place = placeOf(entries, id);
  const original = entryOf(entries, id);
  if (place === undefined || original === undefined) {
    return undefined;
  }
  const copy = newBlockWith(
    JSON.parse(JSON.stringify(original.block)) as PageBlock,
  );
  const after: BlockPlace = { ...place, at: place.at + 1 };
  if (!mayStandAt(entries, copy.block, after)) {
    return undefined;
  }
  return { entries: putIn(entries, after, copy), id: copy.id };
}

/**
 * What taking back the last change to the page's arrangement does.
 *
 * Kept as the act that reverses it rather than as a copy of the page before
 * it. A copy would also take back every word written since, while the text
 * editors on the screen went on showing those words - and the next keystroke
 * would write them over the copy. Reversing only the arrangement leaves the
 * writing alone.
 */
export type ArrangementUndo =
  /** A block was removed: put it back where it was. */
  | { kind: "putBack"; entry: EditorBlock; place: BlockPlace }
  /** A block was added or duplicated: take it out again. */
  | { kind: "takeOut"; id: string }
  /** A block was moved: move it back, to a place read without it. */
  | { kind: "moveBack"; id: string; place: BlockPlace };

/** The page with one change to its arrangement taken back. */
export function undoArrangement(
  entries: readonly EditorBlock[],
  undo: ArrangementUndo,
): EditorBlock[] {
  switch (undo.kind) {
    case "putBack":
      return putIn(entries, undo.place, undo.entry);
    case "takeOut":
      return takeOut(entries, undo.id)?.entries ?? [...entries];
    case "moveBack":
      return moveTo(entries, undo.id, undo.place);
  }
}

/**
 * Where a pointer is, over the page: at one edge of a block, or at the end of
 * a column or of the page.
 */
export type DropTarget =
  | { id: string; edge: "before" | "after" }
  | { parent: string; column: number }
  | { end: true };

/**
 * Where a block dropped at a target goes, and the target the screen should
 * mark for it; or null where dropping it there would change nothing or is
 * not allowed.
 *
 * A block that may not sit in a column, dropped on a block inside one, goes
 * beside the columns block instead - the nearest place it may stand - and the
 * mark moves to the columns block's edge, so what is shown is where it lands.
 */
export function resolveDrop(
  entries: readonly EditorBlock[],
  id: string,
  target: DropTarget,
): { place: BlockPlace; target: DropTarget } | null {
  const out = takeOut(entries, id);
  if (out === undefined) {
    return null;
  }
  const others = out.entries;
  let place: BlockPlace | undefined;
  let shown: DropTarget = target;

  if ("end" in target) {
    place = { list: "page", at: others.length };
  } else if ("parent" in target) {
    const parent = others.find((entry) => entry.id === target.parent);
    const column = (parent?.block as ColumnsBlock | undefined)?.columns[
      target.column
    ];
    place =
      column === undefined
        ? undefined
        : {
            list: "column",
            parent: target.parent,
            column: target.column,
            at: column.blocks.length,
          };
  } else {
    if (target.id === id) {
      return null;
    }
    const over = placeOf(others, target.id);
    place =
      over === undefined
        ? undefined
        : { ...over, at: over.at + (target.edge === "after" ? 1 : 0) };
  }
  if (place === undefined) {
    return null;
  }

  if (place.list === "column" && !mayStandAt(others, out.taken.block, place)) {
    const parent = place.parent;
    const parentAt = others.findIndex((entry) => entry.id === parent);
    if (parentAt === -1) {
      return null;
    }
    const edge =
      "edge" in target && target.edge === "before" && place.at === 0
        ? "before"
        : "after";
    place = { list: "page", at: parentAt + (edge === "after" ? 1 : 0) };
    shown = { id: parent, edge };
  }

  if (
    !mayStandAt(others, out.taken.block, place) ||
    samePlace(place, out.from)
  ) {
    return null;
  }
  return { place, target: shown };
}

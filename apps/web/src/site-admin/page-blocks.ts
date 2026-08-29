import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import type { PageBlock, TextRun } from "../api/site";

/**
 * Working with a page's blocks in the browser.
 *
 * Pure functions over the stored shape, kept apart from the screen so the
 * arranging - adding a block, moving one, taking one out - is testable without
 * a text editor, a network or a rendered component.
 */

/** A block the board can insert, and the order the editor offers them in. */
export const INSERTABLE = ["paragraph", "heading", "image"] as const;

export type InsertableBlock = (typeof INSERTABLE)[number];

export function emptyBlock(kind: InsertableBlock): PageBlock {
  switch (kind) {
    case "paragraph":
      return { type: "paragraph", runs: [] };
    case "heading":
      return { type: "heading", level: 2, runs: [] };
    case "image":
      return { type: "image", mediaFileId: "", alt: "" };
  }
}

export function insertBlock(
  blocks: readonly PageBlock[],
  kind: InsertableBlock,
): PageBlock[] {
  return [...blocks, emptyBlock(kind)];
}

export function replaceBlock(
  blocks: readonly PageBlock[],
  index: number,
  block: PageBlock,
): PageBlock[] {
  return blocks.map((current, at) => (at === index ? block : current));
}

/**
 * Replaces one block with several.
 *
 * A paragraph the board split by pressing return arrives back as more than one
 * paragraph, because the editor's document is mapped paragraph by paragraph.
 * Splicing rather than replacing is what lets that happen without the board
 * having to add a block first.
 */
export function replaceBlockWith(
  blocks: readonly PageBlock[],
  index: number,
  replacements: readonly PageBlock[],
): PageBlock[] {
  return [
    ...blocks.slice(0, index),
    ...replacements,
    ...blocks.slice(index + 1),
  ];
}

export function removeBlock(
  blocks: readonly PageBlock[],
  index: number,
): PageBlock[] {
  return blocks.filter((_, at) => at !== index);
}

/** Moves a block one step, or leaves the list alone at either end. */
export function moveBlock(
  blocks: readonly PageBlock[],
  index: number,
  direction: -1 | 1,
): PageBlock[] {
  const target = index + direction;
  if (
    index < 0 ||
    index >= blocks.length ||
    target < 0 ||
    target >= blocks.length
  ) {
    return [...blocks];
  }
  const moved = [...blocks];
  const [block] = moved.splice(index, 1);
  if (block !== undefined) {
    moved.splice(target, 0, block);
  }
  return moved;
}

/** The plain text of a block, as the warnings and the scan read it. */
export function blockText(block: PageBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.runs.map((run) => run.text).join("");
    case "image":
      return [block.alt, block.caption ?? ""].join(" ").trim();
  }
}

/** Every run of a text block joined into one string, for a plain input. */
export function runsToText(runs: readonly TextRun[]): string {
  return runs.map((run) => run.text).join("");
}

/** One unmarked run, for a field that has no marks to offer. */
export function textToRuns(text: string): TextRun[] {
  return text === "" ? [] : [{ text }];
}

/** Where the page holds something shaped like a personal identity number. */
export interface ScanHit {
  /** The block's position, or null for the page's title. */
  block: number | null;
}

/**
 * Warns before the server refuses.
 *
 * The same scan the API runs, in the browser, so a board member is told while
 * they are still looking at the sentence rather than after pressing publish.
 * It is a courtesy and not a control: the API refuses regardless, which is
 * where the rule actually lives.
 */
export function scanPage(input: {
  title: string;
  blocks: readonly PageBlock[];
}): ScanHit[] {
  const hits: ScanHit[] = [];
  if (scanForPersonalIdentityNumbers(input.title).length > 0) {
    hits.push({ block: null });
  }
  input.blocks.forEach((block, index) => {
    if (scanForPersonalIdentityNumbers(blockText(block)).length > 0) {
      hits.push({ block: index });
    }
  });
  return hits;
}

/** Whether the page carries a picture that was declared to show people. */
export function needsPhotoConsent(
  blocks: readonly PageBlock[],
  identifiable: ReadonlySet<string>,
): boolean {
  return blocks.some(
    (block) => block.type === "image" && identifiable.has(block.mediaFileId),
  );
}

/**
 * The blocks as the API will accept them.
 *
 * A picture with no file chosen yet and a text block with nothing in it are
 * both states the editor allows while somebody is working; neither is a block
 * the website can render, so neither is sent.
 */
export function submittableBlocks(blocks: readonly PageBlock[]): PageBlock[] {
  return blocks.filter((block) =>
    block.type === "image"
      ? block.mediaFileId !== ""
      : block.runs.some((run) => run.text !== ""),
  );
}

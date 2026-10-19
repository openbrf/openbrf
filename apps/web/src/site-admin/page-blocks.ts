import {
  PAGE_BLOCKS,
  type ScannableText,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import type { FaqItem, PageBlock, TextRun } from "../api/site";

/**
 * Working with a page's blocks in the browser.
 *
 * Pure functions over the stored shape, kept apart from the screen so the
 * arranging - adding a block, moving one, taking one out - is testable without
 * a text editor, a network or a rendered component. What each block type is -
 * what it starts as, what of it is the board's writing, when it is finished
 * enough to send - is its definition's, in @openbrf/shared, read by the API as
 * well.
 */

/** The definitions the editor offers to add, in the order it offers them. */
const INSERTABLE_DEFINITIONS = PAGE_BLOCKS.definitions.filter(
  (
    definition,
  ): definition is Extract<
    (typeof PAGE_BLOCKS.definitions)[number],
    { editor: { insert: string } }
  > => definition.editor.insert !== null,
);

/**
 * A block the board can insert, and the order the editor offers them in.
 *
 * Every definition that names an insert label, in the registry's order: prose
 * first, then the picture, then the blocks that name something the instance
 * already holds. Not every block type is here: the two public forms, the news
 * teaser and the controller contact are placed by the screens those features
 * own, and a page can carry one without this list knowing about it.
 */
export const INSERTABLE = INSERTABLE_DEFINITIONS.map(
  (definition) => definition.type,
);

export type InsertableBlock = (typeof INSERTABLE_DEFINITIONS)[number]["type"];

/** The label of the button that adds a block of this kind. */
export function insertLabel(
  kind: InsertableBlock,
): (typeof INSERTABLE_DEFINITIONS)[number]["editor"]["insert"] {
  const definition = INSERTABLE_DEFINITIONS.find(
    (candidate) => candidate.type === kind,
  );
  if (definition === undefined) {
    throw new Error(`"${kind}" is not a block the editor offers`);
  }
  return definition.editor.insert;
}

/**
 * The block's name, as the editor shows it above the block.
 *
 * A block of a type this editor has no definition for is a plugin's whose
 * plugin is not installed. It is named as that rather than by its type id,
 * which would read as a fault to a board member.
 */
export function blockLabel(
  type: PageBlock["type"],
):
  | (typeof PAGE_BLOCKS.definitions)[number]["editor"]["label"]
  | "siteAdmin.editor.blocks.unregistered" {
  return (
    PAGE_BLOCKS.definition(type)?.editor.label ??
    "siteAdmin.editor.blocks.unregistered"
  );
}

/** Whether a block is of a type this editor has a definition for. */
export function isRegistered(block: PageBlock): boolean {
  return PAGE_BLOCKS.definition(block.type) !== undefined;
}

/**
 * A block while the board is arranging it, carrying an identity of its own.
 *
 * The stored shape has no id and is not given one: a page's body is what the
 * website renders, and the editor's bookkeeping is not part of it. But a
 * position is not an identity - moving a block or taking one out renumbers
 * every block after it - and there are two things the editor keys by a block
 * that a wrong answer makes unsafe rather than untidy.
 *
 *   The React key. A paragraph's editor reads its runs once, when it is
 *   created, so keying by position leaves a moved paragraph showing the
 *   document that the previous occupant of that position had - and the next
 *   keystroke writes that document over the block that moved.
 *
 *   The declaration that a picture shows identifiable persons. It is answered
 *   before the file is chosen and travels with the upload, so a declaration
 *   read by position is read off the wrong block once anything has moved. A
 *   picture uploaded as showing nobody is recorded that way on the stored file,
 *   and the publication guardrail never asks for a publiceringssamtycke for it
 *   again.
 */
export interface EditorBlock {
  id: string;
  block: PageBlock;
}

/*
 * A counter rather than a random identifier. It has to be unique among the
 * blocks of one open page and nothing more: it never leaves the browser, is
 * never stored, and never reaches the API. A counter also needs no platform
 * API, so the editor behaves the same in a test environment as in a browser.
 */
let lastId = 0;

function nextId(): string {
  lastId += 1;
  return `block-${lastId}`;
}

/** A page's stored blocks, ready for the editor to arrange. */
export function editorBlocks(blocks: readonly PageBlock[]): EditorBlock[] {
  return blocks.map((block) => ({ id: nextId(), block }));
}

/** The blocks alone, in order, as everything outside the editor reads them. */
export function blocksOf(entries: readonly EditorBlock[]): PageBlock[] {
  return entries.map((entry) => entry.block);
}

/** The same block with new content, keeping the identity it already had. */
export function withBlock(entry: EditorBlock, block: PageBlock): EditorBlock {
  return { id: entry.id, block };
}

/** A block the board has just added and has written nothing in yet. */
export function newEditorBlock(kind: InsertableBlock): EditorBlock {
  return { id: nextId(), block: emptyBlock(kind) };
}

/**
 * A block that already has content but no identity yet.
 *
 * What splitting a paragraph needs. The identity has to come from here rather
 * than be derived from the block that was split: an identity built by appending
 * to another one repeats itself as soon as the same paragraph is split twice,
 * and two blocks sharing one identity is the case this module exists to
 * prevent.
 */
export function newBlockWith(block: PageBlock): EditorBlock {
  return { id: nextId(), block };
}

export function emptyBlock(kind: InsertableBlock): PageBlock {
  const definition = PAGE_BLOCKS.definition(kind);
  if (definition === undefined) {
    throw new Error(`"${kind}" is not a registered block type`);
  }
  return definition.editor.create();
}

/** A question nobody has written yet. */
export function emptyFaqItem(): FaqItem {
  return { question: "", answer: [] };
}

/** The same block with one question rewritten, keeping the others as they are. */
export function withFaqItem(
  items: readonly FaqItem[],
  index: number,
  item: FaqItem,
): FaqItem[] {
  return items.map((current, at) => (at === index ? item : current));
}

export function removeFaqItem(
  items: readonly FaqItem[],
  index: number,
): FaqItem[] {
  return items.filter((_, at) => at !== index);
}

export function insertBlock(
  entries: readonly EditorBlock[],
  kind: InsertableBlock,
): EditorBlock[] {
  return [...entries, newEditorBlock(kind)];
}

export function replaceBlock(
  entries: readonly EditorBlock[],
  index: number,
  entry: EditorBlock,
): EditorBlock[] {
  return entries.map((current, at) => (at === index ? entry : current));
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
  entries: readonly EditorBlock[],
  index: number,
  replacements: readonly EditorBlock[],
): EditorBlock[] {
  return [
    ...entries.slice(0, index),
    ...replacements,
    ...entries.slice(index + 1),
  ];
}

export function removeBlock(
  entries: readonly EditorBlock[],
  index: number,
): EditorBlock[] {
  return entries.filter((_, at) => at !== index);
}

/** Moves a block one step, or leaves the list alone at either end. */
export function moveBlock(
  entries: readonly EditorBlock[],
  index: number,
  direction: -1 | 1,
): EditorBlock[] {
  const target = index + direction;
  if (
    index < 0 ||
    index >= entries.length ||
    target < 0 ||
    target >= entries.length
  ) {
    return [...entries];
  }
  const moved = [...entries];
  const [entry] = moved.splice(index, 1);
  if (entry !== undefined) {
    moved.splice(target, 0, entry);
  }
  return moved;
}

/**
 * Records the stored file on the picture with this identity.
 *
 * Found by identity and read from the list as it stands, because an upload
 * finishes some time after it was begun: the board may have moved the block or
 * written its description while the bytes were on their way, and the answer
 * arriving must not undo either.
 */
export function withUploadedPicture(
  entries: readonly EditorBlock[],
  id: string,
  mediaFileId: string,
): EditorBlock[] {
  return entries.map((entry) =>
    entry.id === id && entry.block.type === "image"
      ? { id: entry.id, block: { ...entry.block, mediaFileId } }
      : entry,
  );
}

/**
 * The plain text of a block, as the warnings and the scan read it.
 *
 * The API's own answer for the same block, from the same definition, because
 * the warning on this screen and the refusal from the server have to agree
 * about which block a personal identity number is in. A block that carries
 * none of the board's own writing has no text: what it shows is scanned where
 * it was written - on the news item, in the archive, on the facts screen.
 */
export function blockText(block: PageBlock): ScannableText {
  return PAGE_BLOCKS.text(block);
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
    const { words, addresses, unreadableAddress } = blockText(block);
    if (
      unreadableAddress ||
      [words, ...addresses].some(
        (text) => scanForPersonalIdentityNumbers(text).length > 0,
      )
    ) {
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
 * The blocks as the API will accept them, and where each one sits on the screen.
 *
 * A picture with no file chosen yet and a text block with nothing in it are
 * both states the editor allows while somebody is working; neither is a block
 * the website can render, so neither is sent.
 *
 * Which means the API counts blocks differently from the board. Its refusals
 * name a position in the body it received, and a notice saying "block 1" while
 * the board is looking at block 2 sends somebody to edit a paragraph that is
 * not the problem. The surviving positions therefore travel beside the blocks,
 * so the screen can map a refusal back rather than recompute the filter.
 */
export interface SubmittableBlocks {
  blocks: PageBlock[];
  /** The editor position of each block sent, by the position it was sent at. */
  positions: number[];
}

export function submittableBlocks(
  blocks: readonly PageBlock[],
): SubmittableBlocks {
  const sent: PageBlock[] = [];
  const positions: number[] = [];

  blocks.forEach((block, index) => {
    if (worthSending(block)) {
      sent.push(block);
      positions.push(index);
    }
  });

  return { blocks: sent, positions };
}

/**
 * Whether a block is finished enough for the website to render it.
 *
 * Asked of the block's definition. A block that names something the instance
 * holds is always ready: there is nothing on it for the board to fill in, and
 * what it shows is decided when the page is rendered.
 *
 * A block of a type this editor does not know - a plugin's, kept while its
 * plugin is not installed - is always sent. A save carries the whole page, so
 * leaving it out of the body would delete it, without anybody having asked for
 * that.
 */
function worthSending(block: PageBlock): boolean {
  return PAGE_BLOCKS.ready(block);
}

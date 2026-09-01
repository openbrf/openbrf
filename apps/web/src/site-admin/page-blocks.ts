import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import type { FaqItem, PageBlock, TextRun } from "../api/site";

/**
 * Working with a page's blocks in the browser.
 *
 * Pure functions over the stored shape, kept apart from the screen so the
 * arranging - adding a block, moving one, taking one out - is testable without
 * a text editor, a network or a rendered component.
 */

/**
 * A block the board can insert, and the order the editor offers them in.
 *
 * Prose first, then the blocks that name something the instance already holds.
 * Not every block type is here: the two public forms and the news teaser are
 * placed by the screens those features own, and a page can carry one without
 * this list knowing about it.
 *
 * The calendar is offered here because no other screen would place it. Putting
 * the association's next dates on the front page is arranging the page, which is
 * this screen's work, and how many dates to show is the only thing to decide.
 */
export const INSERTABLE = [
  "paragraph",
  "heading",
  "image",
  "eventCalendar",
  "documentList",
  "boardRoster",
  "associationFacts",
  "faq",
] as const;

export type InsertableBlock = (typeof INSERTABLE)[number];

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
  switch (kind) {
    case "paragraph":
      return { type: "paragraph", runs: [] };
    case "heading":
      return { type: "heading", level: 2, runs: [] };
    case "image":
      return { type: "image", mediaFileId: "", alt: "" };
    /*
     * Three dates to begin with, which is what fits under a paragraph on a
     * front page without becoming the page. The board changes it in the field
     * beside the block; there is no zero to start from, because a calendar
     * block showing no dates is a block that renders as nothing.
     */
    case "eventCalendar":
      return { type: "eventCalendar", count: 3 };
    // A binder is not chosen here. An absent one lists every document the
    // reader may see, which is the block a board that has just inserted one
    // most often meant.
    case "documentList":
      return { type: "documentList" };
    case "boardRoster":
      return { type: "boardRoster" };
    case "associationFacts":
      return { type: "associationFacts" };
    // One empty question, so the board is looking at the pair of fields it came
    // here to fill in rather than at a button that produces them.
    case "faq":
      return { type: "faq", items: [emptyFaqItem()] };
  }
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
 * The same answer the API's own scanner gives for the same block, because the
 * warning on this screen and the refusal from the server have to agree about
 * which block a personal identity number is in. A block that carries none of
 * the board's own writing has no text: what it shows is scanned where it was
 * written - on the news item, in the archive, on the facts screen.
 */
export function blockText(block: PageBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.runs.map((run) => run.text).join("");
    case "image":
      return [block.alt, block.caption ?? ""].join(" ").trim();
    case "contactForm":
    case "issueReportForm":
      return (block.intro ?? []).map((run) => run.text).join("");
    case "faq":
      return block.items
        .map((item) =>
          [item.question, ...item.answer.map((run) => run.text)].join(" "),
        )
        .join(" ")
        .trim();
    case "newsTeaser":
    case "eventCalendar":
    case "documentList":
    case "boardRoster":
    case "associationFacts":
      return "";
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
 * A block that names something the instance holds is always ready: there is
 * nothing on it for the board to fill in, and what it shows is decided when the
 * page is rendered. A FAQ needs at least one question with an answer under it,
 * for the same reason an empty paragraph is not sent - the API drops the empty
 * entries anyway, and a block left with none of them is a gap in the page.
 */
function worthSending(block: PageBlock): boolean {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.runs.some((run) => run.text !== "");
    case "image":
      return block.mediaFileId !== "";
    case "faq":
      return block.items.some(
        (item) =>
          item.question.trim() !== "" &&
          item.answer.some((run) => run.text !== ""),
      );
    case "contactForm":
    case "issueReportForm":
    case "newsTeaser":
    case "eventCalendar":
    case "documentList":
    case "boardRoster":
    case "associationFacts":
      return true;
  }
}

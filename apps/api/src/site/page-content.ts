import {
  headingBlock,
  type HeadingBlock,
  PAGE_BLOCKS,
  PAGE_CONTENT_LIMITS,
  type PageBlock,
  paragraphBlock,
  type ParagraphBlock,
} from "@openbrf/shared";
import { z } from "zod";

/**
 * What a page's body is, on the way into and out of the database.
 *
 * The column is JSON, and nothing here may assume the shape it finds. The read
 * below is total: it returns the blocks it recognises and drops everything
 * else, because a page whose body was written by a newer editor - or edited by
 * hand in the database - must render less rather than render wrong.
 *
 * Blocks rather than markup is the whole safety argument for the public site. A
 * stored fragment of HTML would let whatever wrote it decide what the browser
 * runs; a block list lets the renderer decide, and the renderer emits text
 * nodes React escapes. There is no block type that can carry a script or a
 * third-party address, and adding one would be a visible change to a block
 * definition and to its renderer.
 *
 * There are two readers, and they are deliberately not one function:
 *
 *   readPageContent is total and forgiving. The renderer uses it, and it never
 *   fails, because a body nobody can parse is a reason to show a thin page
 *   rather than to take the website down.
 *
 *   submittedContentSchema is strict and refuses. The write path uses it, so a
 *   board that wrote a link this platform will not publish is told so, instead
 *   of silently getting a page with the link missing. Strict about keys as well
 *   as about values: a field no block type declares is refused rather than
 *   dropped, because a body quietly stripped of part of itself is the one
 *   answer a write path must not give.
 *
 * What each block type is - its stored shape, its strict schema, its total
 * reading, the text the guardrails scan - is declared once, on its definition
 * in packages/shared/src/page-blocks, and the registry there answers for every
 * type at once (ADR 0006). This module is the API's side of it: the version
 * the body is stored under, the schema built with the API's own zod, and the
 * questions the write service and the renderer ask of a whole body.
 *
 * An unknown block is safe because it renders as nothing rather than as
 * something this version cannot vouch for. A bare type this version does not
 * know is dropped on read and refused on write; a namespaced one - a plugin's
 * block whose plugin is not installed - is kept as stored, so a save does not
 * delete it, and still renders as nothing.
 */

export type {
  AssociationFactsBlock,
  BoardRosterBlock,
  ContactFormBlock,
  ControllerContactBlock,
  DocumentListBlock,
  EventCalendarBlock,
  FaqBlock,
  FaqItem,
  HeadingBlock,
  ImageBlock,
  IssueReportFormBlock,
  NewsTeaserBlock,
  PageBlock,
  ParagraphBlock,
  TextRun,
  UnregisteredBlock,
} from "@openbrf/shared";
export { isPublishableUrl, LINK_PATTERN } from "@openbrf/shared";

export interface PageContent {
  version: 1;
  blocks: PageBlock[];
}

export const PAGE_CONTENT_VERSION = 1;

/**
 * How much a body may hold. Bounds against abuse, not design guidance.
 *
 * Shared with the editor rather than declared here, so the screen cannot offer
 * what this schema would refuse.
 */
const LIMITS = PAGE_CONTENT_LIMITS;

/**
 * The strict shape a submitted body must have.
 *
 * Used by the write path, where refusing is the right answer: the board typed
 * this, so it can be told what was wrong with it. The exception filter turns a
 * failure here into "invalid-body" carrying the field paths, and never the
 * submitted values.
 */
export const submittedContentSchema = z.strictObject({
  blocks: z.array(PAGE_BLOCKS.schema(z)).max(LIMITS.blocks),
});

/**
 * One block of a registered type, and nothing else.
 *
 * For the actions, whose published input must be strict at every depth
 * (assertStrictAtEveryDepth): an unregistered block's fields are exactly the
 * keys nobody here can declare. A caller there reads such a block on a page and
 * is refused if it sends one back, which is a refusal it can act on - where a
 * read that hid the block would let the next save delete it without a word.
 */
export const registeredBlockSchema = PAGE_BLOCKS.registeredSchema(z);

/**
 * The blocks a news item may be written in, as a schema.
 *
 * The runtime already refuses everything else - onlyProse throws
 * unsupported-block for any block isTextBlock rejects - and the published
 * schema has to say the same thing. Publishing all twelve block types to a
 * caller that is a model produces a 400 the document promised was valid, which
 * is the one failure a published contract exists to prevent.
 */
export const proseBlockSchema = z.discriminatedUnion("type", [
  paragraphBlock.schema(z),
  headingBlock.schema(z),
]);

/** Reads a submitted body into the stored shape, refusing what it may not hold. */
export function submittedContent(value: unknown): PageContent {
  const parsed = submittedContentSchema.parse(value);
  return {
    version: PAGE_CONTENT_VERSION,
    blocks: parsed.blocks
      .map((block) => PAGE_BLOCKS.normalize(block))
      .filter((block): block is PageBlock => block !== null),
  };
}

/**
 * The blocks that are prose the board typed, rather than a reference to
 * something else the instance holds.
 *
 * A news item's body is limited to these. A news item is an announcement, and
 * a block that reads a picture or a list of other news out of the database
 * would make one announcement a second place where what the website discloses
 * is decided.
 */
export function isTextBlock(
  block: PageBlock,
): block is ParagraphBlock | HeadingBlock {
  return block.type === "paragraph" || block.type === "heading";
}

/** A body narrowed to its prose, dropping everything else. Total. */
export function textBlocksOnly(content: PageContent): PageContent {
  return {
    version: PAGE_CONTENT_VERSION,
    blocks: content.blocks.filter((block) => isTextBlock(block)),
  };
}

/** Builds a body from plain paragraphs, for a caller that has only text. */
export function paragraphsContent(paragraphs: readonly string[]): PageContent {
  return {
    version: PAGE_CONTENT_VERSION,
    blocks: paragraphs
      .filter((text) => text.trim() !== "")
      .map((text) => ({ type: "paragraph", runs: [{ text }] })),
  };
}

/**
 * Reads a stored body back, keeping only what this renderer understands.
 *
 * An unreadable column yields no blocks rather than throwing: the page still
 * has a title, and a body nobody can parse is a reason to show a thin page, not
 * to take the website down.
 *
 * A paragraph written before runs existed - `{ type: "paragraph", text }` - is
 * still read, as one unmarked run. Bodies already in the database are in that
 * shape and there is no migration to run: the version stays 1 because nothing
 * about the older shape became invalid, only incomplete.
 */
export function readPageContent(value: unknown): PageContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { version: PAGE_CONTENT_VERSION, blocks: [] };
  }

  const raw = (value as { blocks?: unknown }).blocks;
  if (!Array.isArray(raw)) {
    return { version: PAGE_CONTENT_VERSION, blocks: [] };
  }

  const blocks: PageBlock[] = [];
  for (const entry of raw.slice(0, LIMITS.blocks)) {
    const block = PAGE_BLOCKS.read(entry);
    if (block !== null) {
      blocks.push(block);
    }
    // Everything else is skipped on purpose. See the note above: an unknown
    // block is content this renderer cannot vouch for. A namespaced block
    // nobody has registered is the exception, and it is read as it was stored:
    // it renders as nothing either way, and a save must not delete it.
  }

  return { version: PAGE_CONTENT_VERSION, blocks };
}

/**
 * A block's own text, and where the block sits in the body.
 *
 * The words and the addresses apart, so a refusal can say where in the words a
 * number starts and place one in an address by its block alone.
 */
export interface PageTextPart {
  index: number;
  text: string;
  /** Every address the block links to, each as written and decoded. */
  addresses: string[];
  /** Whether one of them is escaped too deeply to be read. */
  unreadableAddress: boolean;
}

/**
 * Every piece of text a body puts in front of a reader, with its position.
 *
 * The publication guardrails scan this rather than the blocks themselves, so a
 * block type added later is scanned the day it is added instead of the day
 * somebody remembers to extend the scanner. An image's alternative text and
 * caption are in here for the same reason: they are published prose, whatever
 * they describe. So is every address a run links to, which is published in the
 * page's HTML even though no reader sees it as text.
 */
export function pageTextParts(content: PageContent): PageTextPart[] {
  return content.blocks.map((block, index) => {
    const { words, addresses, unreadableAddress } = PAGE_BLOCKS.text(block);
    return { index, text: words, addresses, unreadableAddress };
  });
}

/**
 * Whether a body carries a block of a given kind.
 *
 * The question the submit endpoints ask before they accept anything: a form
 * posted to a page that does not carry that form is answered exactly as a page
 * that does not exist is, so a request cannot be used to find out which of the
 * association's pages have forms on them.
 */
export function hasBlock(
  content: PageContent,
  type: PageBlock["type"],
): boolean {
  return content.blocks.some((block) => block.type === type);
}

/** The stored files a body refers to, with the block each reference sits in. */
export function imageReferences(
  content: PageContent,
): { index: number; mediaFileId: string }[] {
  const references: { index: number; mediaFileId: string }[] = [];
  content.blocks.forEach((block, index) => {
    if (block.type === "image") {
      references.push({ index, mediaFileId: block.mediaFileId });
    }
  });
  return references;
}

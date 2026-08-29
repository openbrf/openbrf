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
 * third-party address, and adding one would be a visible change here.
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
 * A block type is added to both of those and to renderBlock in site-html.tsx in
 * one change. That pairing is what makes an unknown block safe: it renders as
 * nothing rather than as something this version cannot vouch for.
 */

/**
 * A stretch of text carrying its marks.
 *
 * Marks are flags rather than nested markup, so there is no tree here to get
 * wrong and no shape in which an attribute could reach the browser. A run is
 * the smallest piece of text whose formatting is uniform: a sentence with two
 * bold words in it is three runs, never one string with markers inside it.
 */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /**
   * Where the run links, when it links anywhere.
   *
   * Checked by isPublishableUrl on the way in and on the way out: http, https,
   * mailto, or a path on this instance. Everything else is refused by the
   * write path and dropped by the read path, so no stored page can put a
   * scheme of its own choosing into an anchor.
   */
  link?: string;
}

/** A paragraph of the association's own prose. */
export interface ParagraphBlock {
  type: "paragraph";
  runs: TextRun[];
}

/**
 * A heading inside the page.
 *
 * Levels 2 and 3 only. The page's title is its single h1, so a heading the
 * board writes always sits below it and the document keeps one outline. A
 * level this parser does not know is not clamped to a valid one: it is refused
 * on write and dropped on read, because guessing which level was meant is the
 * kind of repair that makes a page render wrong.
 */
export interface HeadingBlock {
  type: "heading";
  level: 2 | 3;
  runs: TextRun[];
}

/**
 * A picture, named by the id of the stored file.
 *
 * An id and never a URL. The renderer builds the address from the id through
 * the media route, which is what keeps every image on the association's own
 * origin: a block carrying a URL would be a block that could name somebody
 * else's server, and the promise that reading a page discloses a visitor's
 * address to nobody would be gone with it.
 *
 * The alternative text is required and may be empty, which is the distinction
 * HTML draws between a picture that needs no description and one nobody has
 * described.
 */
export interface ImageBlock {
  type: "image";
  mediaFileId: string;
  alt: string;
  caption?: string;
}

export type PageBlock = ParagraphBlock | HeadingBlock | ImageBlock;

export interface PageContent {
  version: 1;
  blocks: PageBlock[];
}

export const PAGE_CONTENT_VERSION = 1;

/** How much a body may hold. Bounds against abuse, not design guidance. */
const LIMITS = {
  blocks: 200,
  runsPerBlock: 200,
  runText: 5000,
  link: 2000,
  alt: 300,
  caption: 500,
} as const;

/**
 * Whether a URL may be published.
 *
 * An allowlist of schemes rather than a denylist of dangerous ones. There is no
 * end to the second kind of list - javascript:, data:, vbscript:, view-source:,
 * whatever a browser adds next - and the scheme nobody has thought of yet is
 * exactly what a denylist lets through.
 *
 * A path on this instance is allowed, written as "/nagot". A protocol-relative
 * "//exempel.se" is not: it reads as a path and resolves to another origin,
 * which is the one confusion this rule exists to prevent. Backslashes and
 * control characters are refused for a related reason - a browser normalises
 * or strips them, so a check that accepted them would be checking a different
 * string from the one that is finally fetched.
 */
export function isPublishableUrl(value: string): boolean {
  if (value === "" || value.length > LIMITS.link) {
    return false;
  }
  if (value.includes("\\") || hasControlCharacter(value)) {
    return false;
  }

  if (value.startsWith("/")) {
    return !value.startsWith("//");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" ||
    parsed.protocol === "https:" ||
    parsed.protocol === "mailto:"
  );
}

/**
 * Whether a string carries a character a browser would strip or fold.
 *
 * Written as a scan rather than a regular expression because a class of
 * control characters is exactly what a linter flags, and rightly: this is the
 * one place where matching them is the point.
 */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });
}

/*
 * strictObject throughout, and that is the point of the write path rather than
 * a preference. z.object strips a key it does not know, which would mean a body
 * carrying a field this version has no rendering for is accepted and silently
 * loses it - the board told the platform something, the platform answered that
 * it was saved, and it was not. A refusal names the path instead, which is what
 * the exception filter turns into "invalid-body".
 */
const textRunSchema = z.strictObject({
  text: z.string().max(LIMITS.runText),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  link: z.string().refine(isPublishableUrl).optional(),
});

const runsSchema = z.array(textRunSchema).max(LIMITS.runsPerBlock);

const blockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("paragraph"), runs: runsSchema }),
  z.strictObject({
    type: z.literal("heading"),
    level: z.union([z.literal(2), z.literal(3)]),
    runs: runsSchema,
  }),
  z.strictObject({
    type: z.literal("image"),
    mediaFileId: z.string().min(1).max(64),
    alt: z.string().max(LIMITS.alt),
    caption: z.string().max(LIMITS.caption).optional(),
  }),
]);

/**
 * The strict shape a submitted body must have.
 *
 * Used by the write path, where refusing is the right answer: the board typed
 * this, so it can be told what was wrong with it. The exception filter turns a
 * failure here into "invalid-body" carrying the field paths, and never the
 * submitted values.
 */
export const submittedContentSchema = z.strictObject({
  blocks: z.array(blockSchema).max(LIMITS.blocks),
});

/** Reads a submitted body into the stored shape, refusing what it may not hold. */
export function submittedContent(value: unknown): PageContent {
  const parsed = submittedContentSchema.parse(value);
  return {
    version: PAGE_CONTENT_VERSION,
    blocks: parsed.blocks
      .map((block) => normalize(block))
      .filter((block): block is PageBlock => block !== null),
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
    const block = readBlock(entry);
    if (block !== null) {
      blocks.push(block);
    }
    // Everything else is skipped on purpose. See the note above: an unknown
    // block is content this renderer cannot vouch for.
  }

  return { version: PAGE_CONTENT_VERSION, blocks };
}

/** A block's own text, and where the block sits in the body. */
export interface PageTextPart {
  index: number;
  text: string;
}

/**
 * Every piece of text a body puts in front of a reader, with its position.
 *
 * The publication guardrails scan this rather than the blocks themselves, so a
 * block type added later is scanned the day it is added instead of the day
 * somebody remembers to extend the scanner. An image's alternative text and
 * caption are in here for the same reason: they are published prose, whatever
 * they describe.
 */
export function pageTextParts(content: PageContent): PageTextPart[] {
  return content.blocks.map((block, index) => ({
    index,
    text: blockText(block),
  }));
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

function blockText(block: PageBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.runs.map((run) => run.text).join("");
    case "image":
      return [block.alt, block.caption ?? ""].join(" ").trim();
  }
}

/**
 * Drops what a block cannot usefully render.
 *
 * An empty run carries nothing and a text block with no runs left is a gap in
 * the page, so both go. This runs on the write path, which is why a body that
 * arrives with the trailing empty paragraph an editor leaves behind is stored
 * without it.
 */
function normalize(block: PageBlock): PageBlock | null {
  switch (block.type) {
    case "paragraph": {
      const runs = block.runs.filter((run) => run.text !== "");
      return runs.length === 0 ? null : { type: "paragraph", runs };
    }
    case "heading": {
      const runs = block.runs.filter((run) => run.text !== "");
      return runs.length === 0
        ? null
        : { type: "heading", level: block.level, runs };
    }
    case "image":
      return block;
  }
}

function readBlock(entry: unknown): PageBlock | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const block = entry as Record<string, unknown>;

  switch (block["type"]) {
    case "paragraph": {
      const runs = readRuns(block);
      return runs.length === 0 ? null : { type: "paragraph", runs };
    }
    case "heading": {
      const level = block["level"];
      if (level !== 2 && level !== 3) {
        return null;
      }
      const runs = readRuns(block);
      return runs.length === 0 ? null : { type: "heading", level, runs };
    }
    case "image": {
      const mediaFileId = block["mediaFileId"];
      if (typeof mediaFileId !== "string" || mediaFileId === "") {
        return null;
      }
      const alt = block["alt"];
      const caption = block["caption"];
      return {
        type: "image",
        mediaFileId,
        alt: typeof alt === "string" ? alt.slice(0, LIMITS.alt) : "",
        ...(typeof caption === "string" && caption !== ""
          ? { caption: caption.slice(0, LIMITS.caption) }
          : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * The runs of a stored text block, in either shape it may have been written in.
 *
 * A run whose link is not publishable keeps its text and loses the link. That
 * is the read path's whole disposition in one line: show the words the board
 * wrote, never the address this version refuses to vouch for.
 */
function readRuns(block: Record<string, unknown>): TextRun[] {
  const raw = block["runs"];
  if (!Array.isArray(raw)) {
    const legacy = block["text"];
    return typeof legacy === "string" && legacy !== ""
      ? [{ text: legacy.slice(0, LIMITS.runText) }]
      : [];
  }

  const runs: TextRun[] = [];
  for (const entry of raw.slice(0, LIMITS.runsPerBlock)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const run = entry as Record<string, unknown>;
    const text = run["text"];
    if (typeof text !== "string" || text === "") {
      continue;
    }
    const link = run["link"];
    runs.push({
      text: text.slice(0, LIMITS.runText),
      ...(run["bold"] === true ? { bold: true } : {}),
      ...(run["italic"] === true ? { italic: true } : {}),
      ...(typeof link === "string" && isPublishableUrl(link) ? { link } : {}),
    });
  }
  return runs;
}

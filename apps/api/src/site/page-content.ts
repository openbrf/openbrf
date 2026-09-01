import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
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

/**
 * The form the website offers anyone who wants to write to the board.
 *
 * A block with almost nothing in it, and that is the design. The fields are
 * fixed - a name, an address to answer to, and the message - so the board
 * decides where the form sits on the page and never what it asks for. A form
 * whose fields were editable would be a form whose fields could ask for a
 * personal identity number, on a page anybody can read.
 *
 * The intro is the association's own sentence above it, and it is the only
 * content this block carries.
 */
export interface ContactFormBlock {
  type: "contactForm";
  intro?: TextRun[];
}

/**
 * The form a passer-by reports a broken door with.
 *
 * Fixed fields for the same reason as the contact form, plus one the board
 * does configure elsewhere: the issue types, which are offered here filtered to
 * the non-member audience. The block names none of them - which types exist is
 * read when the page is rendered, so a type deactivated this morning is gone
 * from the form this afternoon without anybody editing a page.
 *
 * The block renders as nothing while the association has public issue
 * reporting switched off, which is what lets a page carry it across the switch
 * being turned.
 */
export interface IssueReportFormBlock {
  type: "issueReportForm";
  intro?: TextRun[];
}

/**
 * A list of the association's most recent news, on a page.
 *
 * The block carries no news in it - only how many items to show. What it
 * becomes is resolved by the renderer against the reader's own session, so a
 * page carrying this block shows a visitor with no account the public items and
 * a member theirs as well. Storing the items in the block instead would freeze
 * one reader's answer into a page every reader gets, and would put a
 * member-only headline into a public page's stored body.
 */
export interface NewsTeaserBlock {
  type: "newsTeaser";
  /** How many of the most recent items to show, newest first. */
  count: number;
}

/**
 * The association's own calendar, on a page.
 *
 * The block carries no dates in it - only how many of them to show. What it
 * becomes is resolved by the renderer against the reader's own session, so a
 * page carrying this block shows a visitor with no account the events published
 * to the street and a member the members' ones as well. Storing the dates in
 * the block instead would freeze one reader's answer into a page every reader
 * gets, and would put a member-only cleaning day into a public page's stored
 * body.
 *
 * How many places are gone is the most this block can ever say about who is
 * coming. Who has taken them is personal data about the association's own
 * residents, it is behind events:manage, and there is no field here that could
 * carry a name.
 */
export interface EventCalendarBlock {
  type: "eventCalendar";
  /** How many of the next dates to show, soonest first. */
  count: number;
}

/**
 * The association's document archive, on a page.
 *
 * The block carries no documents in it - at most the binder to narrow to. What
 * it becomes is resolved by the renderer against the reader's own account, so
 * one stored page lists the public shelf to a visitor with no session and the
 * members' shelf as well to a member. Storing the documents in the block
 * instead would freeze one reader's answer into a page every reader gets, and
 * would put a member-only title into a public page's stored body.
 *
 * There is deliberately no audience on this block. Who may read a document is a
 * property of the document, decided once in the archive, and a block that could
 * name an audience would be a second place to decide it - one that a board
 * could get wrong on a page anybody can open.
 *
 * The binder is matched exactly against the archive's own free-text category. A
 * binder nobody has filed anything in lists nothing, and the block then renders
 * as nothing: a page must not announce a shelf the association has not filled.
 */
export interface DocumentListBlock {
  type: "documentList";
  /**
   * The binder to list, or absent for every document the reader may see.
   *
   * Absent and empty are the same thing here, and the write path stores the
   * absence: a binder narrowed to "" would list nothing at all, which is not
   * what a board that cleared the field meant.
   */
  category?: string;
}

/**
 * Who the association's board is, on a page.
 *
 * The block carries no names in it, and that is the whole of its safety
 * argument. Who appears is resolved when the page is rendered, against the
 * publication consent each person has given for exactly this scope - so a
 * consent withdrawn this morning is off the page this afternoon without
 * anybody editing it. A stored roster would be a name published for as long as
 * the page stood, whatever the person later said.
 */
export interface BoardRosterBlock {
  type: "boardRoster";
}

/**
 * The association's own recorded facts, on a page.
 *
 * The same facts the broker information page is generated from, rendered by
 * the same code: a cooperative that would rather answer those questions on a
 * page of its own arranging than at /maklarinfo puts this block on it. The
 * block carries none of them - they are read when the page is rendered, so a
 * fact corrected on the board's screen is corrected everywhere it stands.
 */
export interface AssociationFactsBlock {
  type: "associationFacts";
}

/** One question the association answers, and its answer. */
export interface FaqItem {
  /**
   * The question, as plain text.
   *
   * Not runs, unlike an answer. A question is a label on the answer below it -
   * the markup is a description list - and emphasis or a link inside a label
   * is formatting nobody reads and one more shape for the parser to be wrong
   * about.
   */
  question: string;
  /** The answer, as one paragraph carrying its marks. */
  answer: TextRun[];
}

/**
 * The questions the association is asked, with the board's answers.
 *
 * The one block among these four that carries its own content rather than
 * naming something the instance already holds. That is deliberate and it is
 * why this needs no feature of its own: a FAQ is the board's own writing about
 * its own house, with no second screen to maintain it on and nothing to
 * publish separately - the page it sits on is the thing that is published.
 *
 * An answer is one paragraph. An answer that needs several is a page, and the
 * board can write one and link it from here.
 */
export interface FaqBlock {
  type: "faq";
  items: FaqItem[];
}

export type PageBlock =
  | ParagraphBlock
  | HeadingBlock
  | ImageBlock
  | ContactFormBlock
  | IssueReportFormBlock
  | NewsTeaserBlock
  | EventCalendarBlock
  | DocumentListBlock
  | BoardRosterBlock
  | AssociationFactsBlock
  | FaqBlock;

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
  // A form block takes a type and, at most, the sentence the board wants above
  // it. Nothing else: what the form asks for is fixed by this platform, not
  // configured per page. A field naming anything else is refused rather than
  // dropped: a body that tried to configure the form is told so, instead of
  // being stored without the part it sent.
  z.strictObject({
    type: z.literal("contactForm"),
    intro: runsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("issueReportForm"),
    intro: runsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("newsTeaser"),
    count: z.int().min(1).max(LIMITS.teaserCount),
  }),
  z.strictObject({
    type: z.literal("eventCalendar"),
    count: z.int().min(1).max(LIMITS.calendarCount),
  }),
  // The three blocks that name something the instance already holds. Two of
  // them take nothing at all: what they show is decided when the page is
  // rendered, against the reader, and there is nothing on the block for a
  // board to configure that would not be a second place to decide who may see
  // what.
  z.strictObject({
    type: z.literal("documentList"),
    category: z.string().max(LIMITS.category).optional(),
  }),
  z.strictObject({ type: z.literal("boardRoster") }),
  z.strictObject({ type: z.literal("associationFacts") }),
  z.strictObject({
    type: z.literal("faq"),
    items: z
      .array(
        z.strictObject({
          question: z.string().max(LIMITS.faqQuestion),
          answer: runsSchema,
        }),
      )
      .max(LIMITS.faqItems),
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

function blockText(block: PageBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.runs.map((run) => run.text).join("");
    case "image":
      return [block.alt, block.caption ?? ""].join(" ").trim();
    case "contactForm":
    case "issueReportForm":
      // The intro only. The labels and the button are chrome, translated
      // rather than written by the board, so they are not the board's text to
      // be scanned or held against them.
      return (block.intro ?? []).map((run) => run.text).join("");
    case "faq":
      // Both halves, because both are the board's own writing published on the
      // page. A question is as good a place to paste a personal identity
      // number into as an answer.
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
      // Nothing of the board's own writing. What these blocks show - a news
      // item's title, an event's, a document's, a board member's name, a
      // recorded fact - is scanned where it is written rather than again on
      // every page that names it. The binder on a document list is the
      // exception in shape only: it selects rows rather than being published as
      // prose, and it is bounded to the archive's own category.
      return "";
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
    case "newsTeaser":
    case "eventCalendar":
    case "boardRoster":
    case "associationFacts":
      return block;
    case "documentList": {
      // A binder cleared back to nothing is no binder, not a binder named "".
      // The second would list nothing at all, which is not what the board that
      // emptied the field asked for.
      const category = (block.category ?? "").trim();
      return category === ""
        ? { type: "documentList" }
        : { type: "documentList", category };
    }
    case "faq": {
      const items = block.items
        .map((item) => ({
          question: item.question.trim(),
          answer: item.answer.filter((run) => run.text !== ""),
        }))
        .filter((item) => item.question !== "" && item.answer.length > 0);
      // A question with no answer is a question the page asks the reader, so
      // an entry needs both halves to survive - and a block left with no
      // entries is the empty paragraph case: a gap in the page.
      return items.length === 0 ? null : { type: "faq", items };
    }
    // A form with nothing above it is still a form, unlike a paragraph with no
    // words in it: the block is the form, and the intro is decoration.
    case "contactForm": {
      const intro = (block.intro ?? []).filter((run) => run.text !== "");
      return intro.length === 0
        ? { type: "contactForm" }
        : { type: "contactForm", intro };
    }
    case "issueReportForm": {
      const intro = (block.intro ?? []).filter((run) => run.text !== "");
      return intro.length === 0
        ? { type: "issueReportForm" }
        : { type: "issueReportForm", intro };
    }
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
    case "contactForm": {
      const intro = readRunList(block["intro"]);
      return intro.length === 0
        ? { type: "contactForm" }
        : { type: "contactForm", intro };
    }
    case "issueReportForm": {
      const intro = readRunList(block["intro"]);
      return intro.length === 0
        ? { type: "issueReportForm" }
        : { type: "issueReportForm", intro };
    }
    case "newsTeaser": {
      const count = block["count"];
      // Not clamped to the nearest allowed number: a count this parser does
      // not recognise is a block written by something this renderer cannot
      // vouch for, and showing an arbitrary amount of news would be a guess
      // about what the board meant.
      return typeof count === "number" &&
        Number.isInteger(count) &&
        count >= 1 &&
        count <= LIMITS.teaserCount
        ? { type: "newsTeaser", count }
        : null;
    }
    case "eventCalendar": {
      const count = block["count"];
      // Dropped rather than clamped, for the reason the news teaser above
      // gives: a count outside what this version knows is a block it cannot
      // vouch for, and showing some other number of dates would be a guess.
      return typeof count === "number" &&
        Number.isInteger(count) &&
        count >= 1 &&
        count <= LIMITS.calendarCount
        ? { type: "eventCalendar", count }
        : null;
    }
    case "documentList": {
      const category = block["category"];
      return typeof category === "string" && category.trim() !== ""
        ? {
            type: "documentList",
            category: category.trim().slice(0, LIMITS.category),
          }
        : { type: "documentList" };
    }
    case "boardRoster":
      return { type: "boardRoster" };
    case "associationFacts":
      return { type: "associationFacts" };
    case "faq": {
      const items = readFaqItems(block["items"]);
      return items.length === 0 ? null : { type: "faq", items };
    }
    default:
      return null;
  }
}

/**
 * The questions a stored FAQ block holds.
 *
 * An entry missing either half is dropped rather than repaired. A question
 * with no answer under it is the page asking the reader something, and an
 * answer with no question is a paragraph that has lost what it was about -
 * neither is a thing this renderer can vouch for having been meant.
 */
function readFaqItems(raw: unknown): FaqItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const items: FaqItem[] = [];
  for (const entry of raw.slice(0, LIMITS.faqItems)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const question = item["question"];
    if (typeof question !== "string" || question.trim() === "") {
      continue;
    }
    const answer = readRunList(item["answer"]);
    // Nothing visible under the question is the same as no answer, exactly as
    // a blank question above is the same as no question. A run holding only
    // spaces would otherwise render a heading with an empty space beneath it.
    if (answer.every((run) => run.text.trim() === "")) {
      continue;
    }
    items.push({
      question: question.trim().slice(0, LIMITS.faqQuestion),
      answer,
    });
  }
  return items;
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

  return readRunList(raw);
}

/**
 * A stored list of runs, whatever the column actually held.
 *
 * Separate from readRuns because a form block's intro is a list of runs under a
 * different name and with no older plain-string shape behind it. Both go
 * through here, so there is one answer to what a run may be rather than one per
 * field that holds them.
 */
function readRunList(raw: unknown): TextRun[] {
  if (!Array.isArray(raw)) {
    return [];
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

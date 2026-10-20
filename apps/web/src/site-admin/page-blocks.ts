import {
  type BlockDefinition,
  type BlockRegistry,
  CORE_BLOCKS,
  createBlockRegistry,
  PAGE_BLOCKS,
  PAGE_CONTENT_LIMITS,
  type PluginBlockDeclaration,
  type PluginBlockField,
  pluginBlockDefinition,
  type PluginBlockSettingValue,
  readPluginBlockSettings,
  type ScannableText,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import type {
  ColumnsBlock,
  FaqItem,
  ImageTextBlock,
  NestedBlock,
  PageBlock,
  TextRun,
} from "../api/site";

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

/**
 * The block types this editor knows: the core's, and the serving plugins'.
 *
 * The core's are compiled in. A plugin's are told to the editor by the
 * instance it is editing, because only that instance knows which plugins are
 * installed and switched on, and they become definitions here by the same
 * function the API registers them with - so the editor and the write path
 * agree about when a plugin's block is ready to send.
 */
export type EditorRegistry = BlockRegistry<BlockDefinition>;

export function editorRegistry(
  plugins: readonly PluginBlockDeclaration[],
): EditorRegistry {
  return createBlockRegistry<BlockDefinition>([
    ...CORE_BLOCKS,
    ...plugins.map((declaration) => pluginBlockDefinition(declaration)),
  ]);
}

/** The serving plugin's declaration of a block, or undefined for any other. */
export function pluginBlockOf(
  block: PageBlock,
  plugins: readonly PluginBlockDeclaration[],
): PluginBlockDeclaration | undefined {
  return plugins.find((declaration) => declaration.type === block.type);
}

/** A plugin's block the board has just added, with its declared defaults. */
export function newPluginBlock(
  declaration: PluginBlockDeclaration,
): EditorBlock {
  return newBlockWith(pluginBlockDefinition(declaration).editor.create());
}

/** The settings a plugin's block holds, read as the form shows them. */
export function pluginSettingsOf(
  block: PageBlock,
): Readonly<Record<string, PluginBlockSettingValue>> {
  const settings = (block as { settings?: unknown }).settings;
  return typeof settings === "object" &&
    settings !== null &&
    !Array.isArray(settings)
    ? (settings as Record<string, PluginBlockSettingValue>)
    : {};
}

/**
 * The same block with one setting changed, or taken out.
 *
 * Undefined takes it out rather than storing it, as the plugin's own settings
 * form does: an emptied number box means "not set", and whether that is
 * allowed is the declaration's to decide on the server.
 */
export function withPluginSetting(
  block: PageBlock,
  key: string,
  value: PluginBlockSettingValue | undefined,
): PageBlock {
  const settings: Record<string, PluginBlockSettingValue> = {
    ...pluginSettingsOf(block),
  };
  if (value === undefined) {
    delete settings[key];
  } else {
    settings[key] = value;
  }
  return { ...block, settings } as PageBlock;
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
  /**
   * An identity for each entry of the lists inside the block, for the same two
   * reasons: the blocks in each column of a columns block, and the paragraphs
   * of a picture beside text. Parallel to those lists, and absent for a block
   * that holds none.
   */
  nested?: readonly (readonly string[])[];
  /**
   * Whether the block is on the page as the server holds it: read with the
   * page, or sent in a save that went through. A block the board has only
   * just added is not, and the difference is what decides whether one that
   * is not ready to send may be left out of a save. Leaving out a block the
   * server holds deletes it.
   */
  stored: boolean;
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

/** The lists inside a block, as many entries long as each one is. */
function listsOf(block: PageBlock): readonly (readonly unknown[])[] | null {
  if (block.type === "columns") {
    return (block as ColumnsBlock).columns.map((column) => column.blocks);
  }
  if (block.type === "imageText") {
    return [(block as ImageTextBlock).paragraphs];
  }
  return null;
}

/** A block with an identity, and one for everything in the lists inside it. */
function identified(block: PageBlock, stored: boolean): EditorBlock {
  const lists = listsOf(block);
  return lists === null
    ? { id: nextId(), block, stored }
    : {
        id: nextId(),
        block,
        stored,
        nested: lists.map((list) => list.map(() => nextId())),
      };
}

/** A page's stored blocks, ready for the editor to arrange. */
export function editorBlocks(blocks: readonly PageBlock[]): EditorBlock[] {
  return blocks.map((block) => identified(block, true));
}

/**
 * The same blocks, with the ones a save just sent marked as stored.
 *
 * By identity, because the board may have moved or added blocks while the
 * save was on its way.
 */
export function storedAs(
  entries: readonly EditorBlock[],
  sent: ReadonlySet<string>,
): EditorBlock[] {
  return entries.map((entry) =>
    sent.has(entry.id) && !entry.stored ? { ...entry, stored: true } : entry,
  );
}

/** The blocks alone, in order, as everything outside the editor reads them. */
export function blocksOf(entries: readonly EditorBlock[]): PageBlock[] {
  return entries.map((entry) => entry.block);
}

/**
 * The same block with new content, keeping the identity it already had.
 *
 * And the identities of what is inside it, which is right for every change
 * that leaves the lists inside the block as long as they were. The changes
 * that do not - a block added to a column, a paragraph split - go through the
 * functions below, which keep the two in step.
 */
export function withBlock(entry: EditorBlock, block: PageBlock): EditorBlock {
  return { ...entry, block };
}

/** A block the board has just added and has written nothing in yet. */
export function newEditorBlock(kind: InsertableBlock): EditorBlock {
  return identified(emptyBlock(kind), false);
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
  return identified(block, false);
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
  return entries.map((entry) => {
    const block = entry.block;
    if (
      entry.id === id &&
      (block.type === "image" ||
        block.type === "banner" ||
        block.type === "imageText")
    ) {
      return withBlock(entry, { ...block, mediaFileId } as PageBlock);
    }
    // A picture inside a column is found by its own identity, which survives
    // its being moved within the column while the bytes were on their way.
    if (block.type === "columns" && entry.nested !== undefined) {
      const columns = (block as ColumnsBlock).columns.map((column, at) => ({
        blocks: column.blocks.map((nested, position) =>
          entry.nested?.[at]?.[position] === id && nested.type === "image"
            ? { ...nested, mediaFileId }
            : nested,
        ),
      }));
      return withBlock(entry, { type: "columns", columns });
    }
    return entry;
  });
}

/*
 * The lists inside a block, edited.
 *
 * Each of these changes a list and its identities together, so an identity
 * never ends up beside a different entry from the one it was given to - the
 * same promise EditorBlock makes for the page's own blocks.
 */

/** The blocks in each column of a columns entry, with their identities. */
export function columnsOf(entry: EditorBlock): {
  columns: NestedBlock[][];
  ids: string[][];
} {
  const block = entry.block as ColumnsBlock;
  return {
    columns: block.columns.map((column) => [...column.blocks]),
    ids: block.columns.map((column, at) => {
      const known = entry.nested?.[at] ?? [];
      // Every entry has an identity; one that somehow arrived without is
      // given one rather than left to share its position.
      return column.blocks.map((_, position) => known[position] ?? nextId());
    }),
  };
}

/** A columns entry holding these blocks, under these identities. */
export function columnsEntry(
  entry: EditorBlock,
  columns: NestedBlock[][],
  ids: string[][],
): EditorBlock {
  return {
    ...entry,
    block: { type: "columns", columns: columns.map((blocks) => ({ blocks })) },
    nested: ids,
  };
}

/**
 * Replaces one block in a column with several, as a paragraph split by a
 * return arrives. The first keeps the identity of the block it replaces, and
 * the identities of the others are handed back so the caret can follow.
 */
export function replaceInColumnWith(
  entry: EditorBlock,
  column: number,
  at: number,
  replacements: readonly NestedBlock[],
): { entry: EditorBlock; added: string[] } {
  const { columns, ids } = columnsOf(entry);
  const blocks = columns[column];
  const known = ids[column];
  if (blocks === undefined || known === undefined || at >= blocks.length) {
    return { entry, added: [] };
  }
  // The column keeps to its limit: a split that would overfill it keeps the
  // paragraphs that fit, and RichText is told how many those are.
  const room = PAGE_CONTENT_LIMITS.columnBlocks - blocks.length + 1;
  const kept = replacements.slice(0, Math.max(room, 1));
  const added = kept.slice(1).map(() => nextId());
  blocks.splice(at, 1, ...kept);
  known.splice(at, 1, known[at] ?? nextId(), ...added);
  return { entry: columnsEntry(entry, columns, ids), added };
}

/** Moves a block one step within its column, or leaves it at either end. */
export function moveInColumn(
  entry: EditorBlock,
  column: number,
  at: number,
  direction: -1 | 1,
): EditorBlock {
  const { columns, ids } = columnsOf(entry);
  const blocks = columns[column];
  const known = ids[column];
  const target = at + direction;
  if (
    blocks === undefined ||
    known === undefined ||
    at < 0 ||
    at >= blocks.length ||
    target < 0 ||
    target >= blocks.length
  ) {
    return entry;
  }
  const [block] = blocks.splice(at, 1);
  const [id] = known.splice(at, 1);
  if (block !== undefined && id !== undefined) {
    blocks.splice(target, 0, block);
    known.splice(target, 0, id);
  }
  return columnsEntry(entry, columns, ids);
}

/**
 * The same columns, two or three of them.
 *
 * A column taken away hands what it holds to the one before it rather than
 * deleting it: choosing a narrower layout is not the moment to lose writing. A
 * column holding more than its limit afterwards is the write path's to refuse,
 * and it says which block.
 */
export function withColumnCount(entry: EditorBlock, count: 2 | 3): EditorBlock {
  const { columns, ids } = columnsOf(entry);
  while (columns.length < count) {
    columns.push([]);
    ids.push([]);
  }
  while (columns.length > count) {
    const lastBlocks = columns.pop() ?? [];
    const lastIds = ids.pop() ?? [];
    columns.at(-1)?.push(...lastBlocks);
    ids.at(-1)?.push(...lastIds);
  }
  return columnsEntry(entry, columns, ids);
}

/** The paragraphs of a picture beside text, with their identities. */
function paragraphsOf(entry: EditorBlock): {
  block: ImageTextBlock;
  paragraphs: TextRun[][];
  ids: string[];
} {
  const block = entry.block as ImageTextBlock;
  const known = entry.nested?.[0] ?? [];
  return {
    block,
    paragraphs: [...block.paragraphs],
    ids: block.paragraphs.map((_, at) => known[at] ?? nextId()),
  };
}

/**
 * Replaces one paragraph of a picture beside text with several, as a return
 * splits it. The first keeps its identity; the others' are handed back.
 */
export function replaceParagraphWith(
  entry: EditorBlock,
  at: number,
  replacements: readonly TextRun[][],
): { entry: EditorBlock; added: string[] } {
  const { block, paragraphs, ids } = paragraphsOf(entry);
  if (at >= paragraphs.length) {
    return { entry, added: [] };
  }
  const room = PAGE_CONTENT_LIMITS.imageTextParagraphs - paragraphs.length + 1;
  const kept = replacements.slice(0, Math.max(room, 1));
  const added = kept.slice(1).map(() => nextId());
  paragraphs.splice(at, 1, ...kept);
  ids.splice(at, 1, ids[at] ?? nextId(), ...added);
  return {
    entry: { ...entry, block: { ...block, paragraphs }, nested: [ids] },
    added,
  };
}

/** Adds an empty paragraph to the end of a picture beside text. */
export function addParagraph(entry: EditorBlock): EditorBlock {
  const { block, paragraphs, ids } = paragraphsOf(entry);
  if (paragraphs.length >= PAGE_CONTENT_LIMITS.imageTextParagraphs) {
    return entry;
  }
  return {
    ...entry,
    block: { ...block, paragraphs: [...paragraphs, []] },
    nested: [[...ids, nextId()]],
  };
}

export function removeParagraph(entry: EditorBlock, at: number): EditorBlock {
  const { block, paragraphs, ids } = paragraphsOf(entry);
  return {
    ...entry,
    block: {
      ...block,
      paragraphs: paragraphs.filter((_, position) => position !== at),
    },
    nested: [ids.filter((_, position) => position !== at)],
  };
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

/**
 * Whether the page carries a picture that was declared to show people.
 *
 * Every picture the page shows, as the API checks them: a banner's, one beside
 * text and one inside a column as well as an image block's.
 */
export function needsPhotoConsent(
  blocks: readonly PageBlock[],
  identifiable: ReadonlySet<string>,
): boolean {
  return blocks.some((block) =>
    PAGE_BLOCKS.media(block).some((mediaFileId) =>
      identifiable.has(mediaFileId),
    ),
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
  registry: EditorRegistry = PAGE_BLOCKS,
): SubmittableBlocks {
  const sent: PageBlock[] = [];
  const positions: number[] = [];

  blocks.forEach((block, index) => {
    if (worthSending(block, registry)) {
      // Without what is unfinished inside it: a picture in a column with no
      // file chosen yet is left out as one on the page would be.
      sent.push(registry.sendable(block) as PageBlock);
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
 * A serving plugin's block is ready once every setting its declaration
 * requires is answered. A block of a type this editor does not know - a
 * plugin's, kept while its plugin is not installed or switched off - is always
 * sent. A save carries the whole page, so leaving it out of the body would
 * delete it, without anybody having asked for that. For the same reason a
 * stored plugin's block that is not ready holds the save back rather than
 * being left out of it: see unfinishedStoredBlocks.
 */
function worthSending(block: PageBlock, registry: EditorRegistry): boolean {
  return registry.ready(block);
}

/**
 * The stored blocks of a serving plugin that are no longer ready to send, by
 * their position on the screen.
 *
 * A plugin can change what its block asks for in an upgrade - a setting it
 * now requires, an option it no longer offers - and a block the board set up
 * before then stops being ready. A block the board has only just added and
 * not filled in is left out of a save like a paragraph with nothing in it;
 * one the server already holds cannot be, because the save carries the whole
 * page and leaving it out would delete it and everything set on it. The
 * editor refuses to save while any of these is on the page, and says which,
 * so the board fills in what the plugin now asks for or takes the block out
 * on purpose.
 *
 * Only a plugin's: a core block the server holds that is no longer ready is
 * one the board emptied, and leaving it out is what emptying it means.
 */
export function unfinishedStoredBlocks(
  entries: readonly EditorBlock[],
  registry: EditorRegistry,
): number[] {
  return entries.flatMap(({ block, stored }, index) =>
    stored &&
    PAGE_BLOCKS.definition(block.type) === undefined &&
    registry.definition(block.type) !== undefined &&
    !registry.ready(block)
      ? [index]
      : [],
  );
}

/** A serving plugin's block that is not ready to send, and what it lacks. */
export interface UnfinishedPluginBlock {
  /** Its position on the screen. */
  index: number;
  declaration: PluginBlockDeclaration;
  /** The settings the plugin requires that the block does not answer. */
  missing: PluginBlockField[];
}

/**
 * The serving plugins' blocks that are not ready to send, stored or not, with
 * the settings each one lacks.
 *
 * A block left out of a save without a word looks saved: the board is told
 * "Saved." and the block is gone from the stored page. The editor refuses to
 * save while there is one and names the settings, so the board fills them in
 * or takes the block out.
 */
export function unfinishedPluginBlocks(
  entries: readonly EditorBlock[],
  plugins: readonly PluginBlockDeclaration[],
  registry: EditorRegistry,
): UnfinishedPluginBlock[] {
  return entries.flatMap(({ block }, index) => {
    const declaration = pluginBlockOf(block, plugins);
    if (
      declaration === undefined ||
      PAGE_BLOCKS.definition(block.type) !== undefined ||
      registry.ready(block)
    ) {
      return [];
    }
    const settings = pluginSettingsOf(block);
    const missing = declaration.fields.filter(
      (field) => readPluginBlockSettings([field], settings, "stored") === null,
    );
    return [{ index, declaration, missing }];
  });
}

/**
 * A block as it reads with the empty text runs taken out, so a paragraph the
 * board typed in and deleted again reads as the one that was added.
 */
function withoutEmptyRuns(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter(
        (item) =>
          !(
            typeof item === "object" &&
            item !== null &&
            "text" in item &&
            item.text === ""
          ),
      )
      .map(withoutEmptyRuns);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inside]) => [
        key,
        withoutEmptyRuns(inside),
      ]),
    );
  }
  return value;
}

/** Whether the board has written nothing in a block since it was added. */
function isUntouched(block: PageBlock, registry: EditorRegistry): boolean {
  const created = registry.definition(block.type)?.editor.create();
  return (
    created !== undefined &&
    JSON.stringify(withoutEmptyRuns(block)) ===
      JSON.stringify(withoutEmptyRuns(created))
  );
}

/**
 * What the board has written that a save leaves out, because it is not
 * finished: a picture with a caption and no file, words beside a banner's
 * picture that is not chosen yet, the same inside a column.
 *
 * It is on the screen and nowhere else, so leaving the page loses it, which is
 * what the warning about unsaved changes is for. A block the board added and
 * has written nothing in is not work, and is not here.
 */
export function unfinishedWork(
  blocks: readonly PageBlock[],
  registry: EditorRegistry = PAGE_BLOCKS,
): PageBlock[] {
  const left = (block: PageBlock): PageBlock[] =>
    !registry.ready(block) && !isUntouched(block, registry) ? [block] : [];

  // A columns block is left out whole when nothing in it is ready, so what is
  // unfinished is told by what is inside it either way.
  return blocks.flatMap((block) =>
    block.type === "columns"
      ? (block as ColumnsBlock).columns.flatMap((column) =>
          column.blocks.flatMap(left),
        )
      : left(block),
  );
}

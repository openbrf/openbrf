import type { z } from "zod";

import type { ScannableText } from "../scannable-text.ts";
import type { LinkTarget } from "./link-target.ts";
import type { Zod } from "./text-runs.ts";

/**
 * What one block type is, in the one place it is declared.
 *
 * Everything both applications need to know about a block is on its
 * definition: the type id it is stored under, the strict shape the write path
 * accepts, the total reading the renderer relies on, the text the publication
 * guardrail scans, and how the editor offers it. The markup it becomes is the
 * one part that is not here, because only the API renders the website: the
 * renderer sits beside the rest of the site's markup in apps/api, and the
 * compiler refuses a registered type that has none.
 *
 * Here rather than in either application because both read it (see
 * dev-workspace/AGENTS.md). The editor and the API then cannot disagree about
 * which blocks exist, what a new one starts as, or which block a personal
 * identity number is in.
 */

/**
 * Where the editor files a block when it offers the list to choose from.
 *
 *   text         the board's own writing: paragraphs, headings, questions
 *   media        a stored file shown on the page
 *   layout       how other blocks are arranged, carrying none of its own text
 *   association  something the association already holds, resolved against
 *                the reader when the page is rendered - its news, calendar,
 *                documents, board and facts - and the forms that write to it
 */
export type BlockCategory = "text" | "media" | "layout" | "association";

/**
 * The picture the editor shows beside a block's name.
 *
 * A name rather than an image, so a definition carries no markup and the
 * editor decides how each one is drawn, in the theme's own colours.
 */
export type BlockIcon =
  | "paragraph"
  | "heading"
  | "image"
  | "form"
  | "news"
  | "calendar"
  | "documents"
  | "people"
  | "facts"
  | "contact"
  | "questions"
  | "banner"
  | "columns"
  | "button"
  | "imageText";

/**
 * The strict schema of one block, as an option of the block union.
 *
 * Discriminable, because the write path is a discriminated union over the
 * registered types: a block names its type, and only that type's schema is
 * asked about it, so a refusal points into the block rather than at it.
 */
export type BlockSchema<B> = z.ZodType<B> & z.core.$ZodTypeDiscriminable;

/**
 * How the editor offers a block. Read by apps/web; the API ignores it.
 *
 * The two labels keep their literal keys in the type, so the editor's typed
 * translation function refuses a key that is in neither locale at compile
 * time rather than showing it to a board member.
 */
export interface BlockEditorMetadata<
  B,
  Label extends string = string,
  Insert extends string | null = string | null,
> {
  /** The block's name, as an i18n key. */
  readonly label: Label;
  /**
   * The label of the button that adds one, as an i18n key, or null for a
   * block the page editor does not offer.
   *
   * Null is not "hidden". The two public forms, the news teaser and the
   * controller contact are placed by the screens their features own, and a
   * page carrying one shows it in the editor like any other block.
   */
  readonly insert: Insert;
  readonly icon: BlockIcon;
  readonly category: BlockCategory;
  /**
   * Whether the block may sit inside a column.
   *
   * Columns nest one level and never hold columns, so this is false for every
   * layout block. A block that reads something per page - a form, a list of
   * news - stays false until the renderer looks inside columns for it.
   */
  readonly nestable: boolean;
  /** The block as it is added, before the board has written anything in it. */
  create(): B;
  /**
   * Whether the block is finished enough to send.
   *
   * A picture with no file and a paragraph with no words are states the editor
   * allows while somebody is working, and neither is a block the website can
   * render. Absent means always ready: a block with nothing to fill in.
   */
  ready?(block: B): boolean;
  /**
   * The block as the editor sends it, with whatever inside it is not finished
   * left out.
   *
   * For a block that holds others: a picture in a column with no file chosen
   * yet is a state the editor allows, and not one the write path accepts.
   * Absent sends the block as it is.
   */
  sendable?(block: B): B;
}

/**
 * One block type.
 *
 * Methods rather than function-valued properties, so a definition of one block
 * is a definition of "a block" as the registry handles them.
 */
export interface BlockDefinition<
  B extends PageBlockShape = PageBlockShape,
  Label extends string = string,
  Insert extends string | null = string | null,
> {
  /**
   * The id every stored block of this type carries.
   *
   * A core block's is a bare lowerCamelCase word. A plugin's is namespaced by
   * the plugin's id, `<plugin id>/<name>`, so two plugins cannot claim the
   * same type and neither can claim one of the core's.
   */
  readonly type: B["type"];
  /**
   * The strict shape the write path accepts.
   *
   * Built from the caller's zod rather than from an import here, so the schema
   * is made of the copy the caller validates and publishes with: the API's
   * action registry refuses one built by a second copy (isHostZodSchema), and
   * the editor, which reads everything else on a definition, never builds it.
   */
  schema(zod: Zod): BlockSchema<B>;
  /**
   * A stored block of this type, as far as this version can vouch for it.
   *
   * Total: it never throws, and null drops the block. Not clamped to the
   * nearest valid value either - a field this version does not recognise is a
   * block it cannot vouch for, and guessing what was meant is the kind of
   * repair that makes a page render wrong.
   */
  read(stored: Readonly<Record<string, unknown>>): B | null;
  /**
   * What the write path stores of an accepted block, or null to leave it out.
   *
   * Absent stores the block as it was accepted.
   */
  normalize?(block: B): B | null;
  /**
   * Everything on the block that is the board's own writing.
   *
   * What the publication guardrails scan for a personal identity number. A
   * block that shows something held elsewhere - a news item, a document - has
   * none: that is scanned where it is written, not again on every page that
   * names it.
   */
  text(block: B): ScannableText;
  /**
   * The ids of the stored files the block shows, in the order it shows them.
   *
   * What the publication guardrails check for a public file and a confirmed
   * consent. Absent for a block that shows no picture.
   */
  media?(block: B): readonly string[];
  /**
   * Where the block's buttons lead, in order.
   *
   * What the renderer resolves before the page is rendered: a page is named
   * by its id, and whether this reader may follow a button to it is a question
   * about the page, asked once for the whole body. Absent for a block with no
   * button.
   */
  linkTargets?(block: B): readonly LinkTarget[];
  readonly editor: BlockEditorMetadata<B, Label, Insert>;
}

/**
 * Declares a block type: `defineBlock<ParagraphBlock>()({ ... })`.
 *
 * Two calls so the block's own interface is named once and the label keys are
 * still inferred as the literals they are. A definition typed as
 * BlockDefinition<ParagraphBlock> would widen them to string, and an
 * annotation-free object would lose the interface the stored shape is
 * documented on.
 */
export function defineBlock<B extends PageBlockShape>() {
  return <const Label extends string, const Insert extends string | null>(
    definition: BlockDefinition<B, Label, Insert>,
  ): BlockDefinition<B, Label, Insert> => definition;
}

/** The one thing every block has in common. */
export interface PageBlockShape {
  type: string;
}

/**
 * The type id of a core block.
 *
 * lowerCamelCase with no separator, which is what keeps the core's ids and
 * the namespaced ones apart by their shape alone.
 */
export const CORE_BLOCK_TYPE_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * The type id of a block that belongs to a plugin: `<plugin id>/<name>`.
 *
 * The namespace is a plugin id as the manifest has it - lowercase letters,
 * digits and single hyphens, at most 48 characters - and the name is a core
 * block's shape.
 */
export const NAMESPACED_BLOCK_TYPE_PATTERN =
  /^(?=[^/]{1,48}\/)[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-zA-Z0-9]{0,31}$/;

/** A namespaced type id, as the compiler sees it. */
export type NamespacedBlockType = `${string}/${string}`;

export function isNamespacedBlockType(
  type: string,
): type is NamespacedBlockType {
  return NAMESPACED_BLOCK_TYPE_PATTERN.test(type);
}

/**
 * A block of a namespaced type that no definition is registered for.
 *
 * What a page holds when the plugin that wrote a block is not installed, or
 * not yet enabled. It renders as nothing, and it is kept exactly as stored: a
 * save carries the whole page, and dropping it there would delete the board's
 * work for no better reason than a plugin being switched off for an afternoon.
 *
 * A bare type this version does not know is not one of these. It is a block
 * from a newer core, and it is dropped on read and refused on write as before.
 */
export interface UnregisteredBlock {
  type: NamespacedBlockType;
  [field: string]: unknown;
}

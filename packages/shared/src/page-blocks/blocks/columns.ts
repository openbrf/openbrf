import type { z } from "zod";

import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import type { ScannableText } from "../../scannable-text.ts";
import {
  type BlockDefinition,
  type BlockSchema,
  defineBlock,
  type PageBlockShape,
} from "../definition.ts";
import { isRecord, type Zod } from "../text-runs.ts";
import { type ButtonBlock, buttonBlock } from "./button.ts";
import { type HeadingBlock, headingBlock } from "./heading.ts";
import { type ImageBlock, imageBlock } from "./image.ts";
import { type ParagraphBlock, paragraphBlock } from "./paragraph.ts";

const LIMITS = PAGE_CONTENT_LIMITS;

/**
 * The blocks a column may hold, in the order the editor offers them.
 *
 * Exactly the definitions that say they are nestable, which a spec holds the
 * registry to. Listed here rather than read from the registry because the
 * registry is built from this block: a column cannot ask the list it is in
 * which blocks it may hold.
 *
 * No layout block is here, so a column never holds columns, a banner or a
 * picture beside text, and nesting stops at one level by construction rather
 * than by a check somebody has to remember. No block that reads something per
 * page is here either - a form, a list of news - because the renderer and the
 * form endpoints look for those among the page's own blocks and not inside
 * columns.
 */
export const NESTED_BLOCKS = [
  paragraphBlock,
  headingBlock,
  imageBlock,
  buttonBlock,
] as const;

/** A block inside a column. */
export type NestedBlock =
  ParagraphBlock | HeadingBlock | ImageBlock | ButtonBlock;

export type NestedBlockType = NestedBlock["type"];

/** One column: the blocks in it, top to bottom. */
export interface Column {
  blocks: NestedBlock[];
}

/**
 * Two or three columns side by side, each a list of blocks.
 *
 * Side by side on a screen wide enough, and one after the other on a telephone,
 * first column first: the order a reader is given the columns in is the order
 * the board wrote them, whatever the width.
 *
 * The count is the board's choice and is kept even while a column is empty -
 * an empty column is space the board left, not a block that failed to read. A
 * columns block with nothing in any of them is a gap in the page and is not
 * stored.
 */
export interface ColumnsBlock {
  type: "columns";
  columns: Column[];
}

const NESTED_BY_TYPE: ReadonlyMap<string, BlockDefinition> = new Map(
  NESTED_BLOCKS.map((definition) => [
    definition.type,
    definition as unknown as BlockDefinition,
  ]),
);

/** The definition of a block that may sit in a column, or undefined. */
export function nestedDefinition(type: string): BlockDefinition | undefined {
  return NESTED_BY_TYPE.get(type);
}

/** The strict shape of a block inside a column. */
function nestedSchema(zod: Zod): z.ZodType<NestedBlock> {
  const [first, ...rest] = NESTED_BLOCKS.map(
    (definition): BlockSchema<PageBlockShape> =>
      (definition as unknown as BlockDefinition).schema(zod),
  );
  if (first === undefined) {
    throw new Error("a column needs at least one block type");
  }
  // A discriminated union over the nestable types alone, so a columns block,
  // a banner or a form inside a column is refused with the path of the block
  // that is not allowed there.
  return zod.discriminatedUnion("type", [
    first,
    ...rest,
  ]) as unknown as z.ZodType<NestedBlock>;
}

/**
 * Every block in every column, in reading order, with its definition.
 *
 * A block no nestable definition covers is passed over rather than thrown at.
 * The write path and the read path never let one in, but the guardrails' scan
 * also runs on the editor's working copy of a page, and it has to answer for
 * whatever that holds.
 */
function nestedBlocks(
  block: ColumnsBlock,
): { nested: NestedBlock; definition: BlockDefinition }[] {
  return block.columns.flatMap((column) =>
    column.blocks.flatMap((nested) => {
      const definition = NESTED_BY_TYPE.get(nested.type);
      return definition === undefined ? [] : [{ nested, definition }];
    }),
  );
}

/** The blocks of one stored column, as far as this version can vouch for them. */
function readColumn(raw: unknown): Column {
  const stored = isRecord(raw) ? raw["blocks"] : undefined;
  if (!Array.isArray(stored)) {
    return { blocks: [] };
  }
  const blocks: NestedBlock[] = [];
  for (const entry of stored.slice(0, LIMITS.columnBlocks)) {
    if (!isRecord(entry) || typeof entry["type"] !== "string") {
      continue;
    }
    // A block that may not sit in a column is dropped like a block of a type
    // nobody knows: a column holding columns is a shape this renderer has no
    // rendering for, whatever wrote it.
    const read = NESTED_BY_TYPE.get(entry["type"])?.read(entry) ?? null;
    if (read !== null) {
      blocks.push(read as NestedBlock);
    }
  }
  return { blocks };
}

/** The columns block, or null when no column holds anything. */
function withColumns(columns: Column[]): ColumnsBlock | null {
  return columns.every((column) => column.blocks.length === 0)
    ? null
    : { type: "columns", columns };
}

export const columnsBlock = defineBlock<ColumnsBlock>()({
  type: "columns",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("columns"),
      columns: zod
        .array(
          zod.strictObject({
            blocks: zod.array(nestedSchema(zod)).max(LIMITS.columnBlocks),
          }),
        )
        .min(LIMITS.columnsMin)
        .max(LIMITS.columnsMax),
    }),
  read: (stored) => {
    const columns = stored["columns"];
    // Not clamped to the nearest count: four columns cut to three would drop
    // whatever the fourth held, and one stretched to two would be a layout
    // the board did not choose.
    if (
      !Array.isArray(columns) ||
      columns.length < LIMITS.columnsMin ||
      columns.length > LIMITS.columnsMax
    ) {
      return null;
    }
    return withColumns(columns.map((column) => readColumn(column)));
  },
  normalize: (block) =>
    withColumns(
      block.columns.map((column) => ({
        blocks: column.blocks.flatMap((nested) => {
          const definition = NESTED_BY_TYPE.get(nested.type);
          if (definition === undefined) {
            return [];
          }
          const kept =
            definition.normalize === undefined
              ? nested
              : definition.normalize(nested);
          return kept === null ? [] : [kept as NestedBlock];
        }),
      })),
    ),
  text: (block) => {
    // Every block in it, in reading order and apart by a space, so the end of
    // one block and the start of the next are not read as one number. The
    // guardrails place a refusal by the columns block, which is the block the
    // board sees on the page.
    const parts: ScannableText[] = nestedBlocks(block).map(
      ({ nested, definition }) => definition.text(nested),
    );
    return {
      words: parts
        .map((part) => part.words)
        .filter((words) => words !== "")
        .join(" "),
      addresses: parts.flatMap((part) => part.addresses),
      unreadableAddress: parts.some((part) => part.unreadableAddress),
    };
  },
  media: (block) =>
    nestedBlocks(block).flatMap(
      ({ nested, definition }) => definition.media?.(nested) ?? [],
    ),
  linkTargets: (block) =>
    nestedBlocks(block).flatMap(
      ({ nested, definition }) => definition.linkTargets?.(nested) ?? [],
    ),
  editor: {
    label: "siteAdmin.editor.blocks.columns",
    insert: "siteAdmin.editor.add.columns",
    icon: "columns",
    category: "layout",
    nestable: false,
    create: () => ({
      type: "columns",
      columns: [{ blocks: [] }, { blocks: [] }],
    }),
    ready: (block) =>
      nestedBlocks(block).some(
        ({ nested, definition }) => definition.editor.ready?.(nested) ?? true,
      ),
    // A block in a column is sent on the same terms as one on the page: a
    // picture with no file and a paragraph with no words are left out.
    sendable: (block) => ({
      type: "columns",
      columns: block.columns.map((column) => ({
        blocks: column.blocks.flatMap((nested) => {
          const editor = NESTED_BY_TYPE.get(nested.type)?.editor;
          if (editor === undefined || !(editor.ready?.(nested) ?? true)) {
            return [];
          }
          return [(editor.sendable?.(nested) ?? nested) as NestedBlock];
        }),
      })),
    }),
  },
});

import type { z } from "zod";

import { PAGE_CONTENT_LIMITS } from "../page-content-limits.ts";
import { scannableRuns, type ScannableText } from "../scannable-text.ts";
import { associationFactsBlock } from "./blocks/association-facts.ts";
import { boardRosterBlock } from "./blocks/board-roster.ts";
import { controllerContactBlock } from "./blocks/controller-contact.ts";
import { documentListBlock } from "./blocks/document-list.ts";
import { eventCalendarBlock } from "./blocks/event-calendar.ts";
import { faqBlock } from "./blocks/faq.ts";
import { contactFormBlock, issueReportFormBlock } from "./blocks/forms.ts";
import { headingBlock } from "./blocks/heading.ts";
import { imageBlock } from "./blocks/image.ts";
import { newsTeaserBlock } from "./blocks/news-teaser.ts";
import { paragraphBlock } from "./blocks/paragraph.ts";
import {
  type BlockDefinition,
  type BlockSchema,
  CORE_BLOCK_TYPE_PATTERN,
  isNamespacedBlockType,
  NAMESPACED_BLOCK_TYPE_PATTERN,
  type PageBlockShape,
  type UnregisteredBlock,
} from "./definition.ts";
import { isRecord, type Zod } from "./text-runs.ts";

/**
 * Every block type the core ships, in the order the editor offers them.
 *
 * Prose first, then the picture, then the blocks that name something the
 * instance already holds. A block type is added in its own file under blocks/
 * and listed here, with its renderer in BLOCK_RENDERERS in
 * apps/api/src/site/site-html.tsx (which the compiler asks for) and its labels
 * in both locales - and nowhere else.
 */
export const CORE_BLOCKS = [
  paragraphBlock,
  headingBlock,
  imageBlock,
  contactFormBlock,
  issueReportFormBlock,
  newsTeaserBlock,
  eventCalendarBlock,
  documentListBlock,
  boardRosterBlock,
  associationFactsBlock,
  controllerContactBlock,
  faqBlock,
] as const;

type CoreDefinition = (typeof CORE_BLOCKS)[number];

/** The block a definition describes. */
export type BlockOf<D> =
  D extends BlockDefinition<infer B, string, string | null> ? B : never;

/** A block of one of the core's own types. */
export type CoreBlock = BlockOf<CoreDefinition>;

export type CoreBlockType = CoreBlock["type"];

/**
 * A block as a page holds it.
 *
 * One of the registered types, or a namespaced one this version keeps without
 * understanding. A bare type outside the registry is not in here at all: the
 * read path drops it and the write path refuses it.
 */
export type PageBlock = CoreBlock | UnregisteredBlock;

/**
 * The block types a page may hold, and everything that is done to a block by
 * its type.
 *
 * Every switch over a block's type that used to be written out by hand - in
 * the reader, the write schema, the normaliser, the scanner and the editor - is
 * a lookup here instead, so a type cannot be known to one of them and missing
 * from another.
 */
export interface BlockRegistry<D extends BlockDefinition> {
  readonly definitions: readonly D[];
  /** The definition of a type, or undefined for one nobody registered. */
  definition(type: string): D | undefined;
  /**
   * The strict shape of one block, as the write path accepts it.
   *
   * One of the registered types, or an unregistered namespaced block within
   * PAGE_CONTENT_LIMITS.unregisteredBlock. See unregisteredSchema below for how
   * the two are joined without losing the path of a refusal.
   */
  schema(zod: Zod): z.ZodType<BlockOf<D> | UnregisteredBlock>;
  /**
   * The registered types alone, strict at every depth.
   *
   * For a published document that must not accept a key it does not declare:
   * an unregistered block's fields are exactly what nobody here can declare.
   */
  registeredSchema(zod: Zod): z.ZodType<BlockOf<D>>;
  /** A stored block, read totally: null drops it, and nothing throws. */
  read(stored: unknown): BlockOf<D> | UnregisteredBlock | null;
  /** What the write path stores of an accepted block, or null to drop it. */
  normalize(block: PageBlockShape): BlockOf<D> | UnregisteredBlock | null;
  /** The board's own writing on a block, as the guardrails scan it. */
  text(block: PageBlockShape): ScannableText;
  /** Whether the editor would send a block, rather than wait for more of it. */
  ready(block: PageBlockShape): boolean;
}

/**
 * A registry over a list of definitions.
 *
 * Refuses a list that two definitions claim one type in, and a type id of
 * neither shape: an id is what a stored block is matched to, and an ambiguous
 * one would render one plugin's block with another's renderer.
 */
export function createBlockRegistry<const D extends BlockDefinition>(
  definitions: readonly D[],
): BlockRegistry<D> {
  const byType = new Map<string, D>();
  for (const definition of definitions) {
    if (
      !CORE_BLOCK_TYPE_PATTERN.test(definition.type) &&
      !NAMESPACED_BLOCK_TYPE_PATTERN.test(definition.type)
    ) {
      throw new Error(`"${definition.type}" is not a block type id`);
    }
    if (byType.has(definition.type)) {
      throw new Error(`"${definition.type}" is registered twice`);
    }
    byType.set(definition.type, definition);
  }

  type Block = BlockOf<D> | UnregisteredBlock;
  const unregistered = (type: string): type is UnregisteredBlock["type"] =>
    isNamespacedBlockType(type) && !byType.has(type);

  return {
    definitions,
    definition: (type) => byType.get(type),
    schema: (zod) =>
      zod.union([
        registeredSchema(zod, definitions),
        unregisteredSchema(zod, unregistered),
      ]) as unknown as z.ZodType<Block>,
    registeredSchema: (zod) =>
      registeredSchema(zod, definitions) as unknown as z.ZodType<BlockOf<D>>,
    read: (stored) => {
      if (!isRecord(stored) || typeof stored["type"] !== "string") {
        return null;
      }
      const type = stored["type"];
      const definition = byType.get(type);
      if (definition !== undefined) {
        return definition.read(stored) as Block | null;
      }
      return unregistered(type) ? readUnregistered(stored) : null;
    },
    normalize: (block) => {
      const definition = byType.get(block.type);
      if (definition === undefined) {
        return block as Block;
      }
      return definition.normalize === undefined
        ? (block as Block)
        : (definition.normalize(block) as Block | null);
    },
    text: (block) => {
      const definition = byType.get(block.type);
      return definition === undefined
        ? unregisteredText(block)
        : definition.text(block);
    },
    ready: (block) => byType.get(block.type)?.editor.ready?.(block) ?? true,
  };
}

/** The core's own blocks, and the registry the API and the editor read. */
export const PAGE_BLOCKS = createBlockRegistry(CORE_BLOCKS);

/** The discriminated union over the registered types. */
function registeredSchema(zod: Zod, definitions: readonly BlockDefinition[]) {
  const [first, ...rest] = definitions.map(
    (definition): BlockSchema<PageBlockShape> => definition.schema(zod),
  );
  if (first === undefined) {
    throw new Error("a block registry needs at least one block type");
  }
  return zod.discriminatedUnion("type", [first, ...rest]);
}

/**
 * The envelope a namespaced block nobody has registered is accepted in.
 *
 * Unioned with the registered types on the write path, and the way it fails is
 * what keeps that union's refusals useful. Zod reports a failure in both halves
 * of a union as one "invalid_union" at the block, which would lose the path
 * into it - and a refusal that says `content.blocks.3.runs.0.link` is how the
 * editor tells the board which link it will not publish. So the type check
 * here aborts: a block of a registered type fails it fatally, and zod then
 * reports the one half that failed without aborting, which is the registered
 * type's own schema with its paths intact. A block whose shape is wrong at its
 * root - a field no type declares, a level that is not 2 or 3 - aborts both
 * halves and is refused at the block, which still names the block.
 *
 * The block is held to its type id and to a size. Its fields are not checked
 * because nobody here knows them: it is stored, scanned, and rendered as
 * nothing until the plugin that owns it is installed again.
 */
function unregisteredSchema(zod: Zod, unregistered: (type: string) => boolean) {
  return zod
    .looseObject({
      type: zod
        .string()
        .regex(NAMESPACED_BLOCK_TYPE_PATTERN, { abort: true })
        .refine(unregistered, { abort: true }),
    })
    .refine(
      (block) =>
        JSON.stringify(block).length <= PAGE_CONTENT_LIMITS.unregisteredBlock,
    );
}

/**
 * A stored block of a namespaced type nobody has registered, exactly as stored.
 *
 * Copied through JSON rather than kept by reference, so what is handed on is
 * plain data and nothing the column's driver attached to it. Over the size the
 * write path allows, it is dropped like any other block this version cannot
 * vouch for.
 */
function readUnregistered(
  stored: Readonly<Record<string, unknown>>,
): UnregisteredBlock | null {
  const serialized = JSON.stringify(stored);
  if (serialized.length > PAGE_CONTENT_LIMITS.unregisteredBlock) {
    return null;
  }
  return JSON.parse(serialized) as UnregisteredBlock;
}

/**
 * Every string on an unregistered block, read as words and as an address both.
 *
 * Nobody here knows which of its fields the plugin will print, or put in an
 * href, once it is installed again - so all of them are scanned, and a block
 * of a type this version cannot read is held to more than any block it can.
 */
function unregisteredText(block: PageBlockShape): ScannableText {
  const values: string[] = [];
  for (const [field, value] of Object.entries(block)) {
    if (field !== "type") {
      collectStrings(value, values);
    }
  }
  const addresses = scannableRuns(
    values.map((value) => ({ text: "", link: value })),
  );
  return {
    words: values.join(" "),
    addresses: addresses.addresses,
    unreadableAddress: addresses.unreadableAddress,
  };
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, into);
    }
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectStrings(entry, into);
    }
  }
}

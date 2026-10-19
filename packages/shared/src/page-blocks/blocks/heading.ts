import { scannableRuns } from "../../scannable-text.ts";
import { defineBlock } from "../definition.ts";
import { keptRuns, readRuns, runsSchema, type TextRun } from "../text-runs.ts";

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

export const headingBlock = defineBlock<HeadingBlock>()({
  type: "heading",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("heading"),
      level: zod.union([zod.literal(2), zod.literal(3)]),
      runs: runsSchema(zod),
    }),
  read: (stored) => {
    const level = stored["level"];
    if (level !== 2 && level !== 3) {
      return null;
    }
    const runs = readRuns(stored);
    return runs.length === 0 ? null : { type: "heading", level, runs };
  },
  normalize: (block) => {
    const runs = keptRuns(block.runs);
    return runs.length === 0
      ? null
      : { type: "heading", level: block.level, runs };
  },
  text: (block) => scannableRuns(block.runs),
  editor: {
    label: "siteAdmin.editor.blocks.heading",
    insert: "siteAdmin.editor.add.heading",
    icon: "heading",
    category: "text",
    nestable: true,
    create: () => ({ type: "heading", level: 2, runs: [] }),
    ready: (block) => block.runs.some((run) => run.text !== ""),
  },
});

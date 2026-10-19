import { scannableRuns } from "../../scannable-text.ts";
import { defineBlock } from "../definition.ts";
import { keptRuns, readRuns, runsSchema, type TextRun } from "../text-runs.ts";

/** A paragraph of the association's own prose. */
export interface ParagraphBlock {
  type: "paragraph";
  runs: TextRun[];
}

export const paragraphBlock = defineBlock<ParagraphBlock>()({
  type: "paragraph",
  schema: (zod) =>
    zod.strictObject({ type: zod.literal("paragraph"), runs: runsSchema(zod) }),
  read: (stored) => {
    const runs = readRuns(stored);
    return runs.length === 0 ? null : { type: "paragraph", runs };
  },
  // An empty run carries nothing, and a paragraph with no runs left is a gap
  // in the page. Both go, which is why the trailing empty paragraph an editor
  // leaves behind is not stored.
  normalize: (block) => {
    const runs = keptRuns(block.runs);
    return runs.length === 0 ? null : { type: "paragraph", runs };
  },
  text: (block) => scannableRuns(block.runs),
  editor: {
    label: "siteAdmin.editor.blocks.paragraph",
    insert: "siteAdmin.editor.add.paragraph",
    icon: "paragraph",
    category: "text",
    nestable: true,
    create: () => ({ type: "paragraph", runs: [] }),
    ready: (block) => block.runs.some((run) => run.text !== ""),
  },
});

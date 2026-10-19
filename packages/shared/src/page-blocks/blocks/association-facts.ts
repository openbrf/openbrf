import { defineBlock } from "../definition.ts";
import { wordsOnly } from "../text-runs.ts";

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

export const associationFactsBlock = defineBlock<AssociationFactsBlock>()({
  type: "associationFacts",
  schema: (zod) => zod.strictObject({ type: zod.literal("associationFacts") }),
  read: () => ({ type: "associationFacts" }),
  // A fact is scanned on the facts screen, where it is written.
  text: () => wordsOnly(""),
  editor: {
    label: "siteAdmin.editor.blocks.associationFacts",
    insert: "siteAdmin.editor.add.associationFacts",
    icon: "facts",
    category: "association",
    nestable: false,
    create: () => ({ type: "associationFacts" }),
  },
});

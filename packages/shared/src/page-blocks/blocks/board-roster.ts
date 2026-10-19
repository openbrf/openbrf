import { defineBlock } from "../definition.ts";
import { wordsOnly } from "../text-runs.ts";

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

export const boardRosterBlock = defineBlock<BoardRosterBlock>()({
  type: "boardRoster",
  // Nothing on the block for a board to configure that would not be a second
  // place to decide who may see what.
  schema: (zod) => zod.strictObject({ type: zod.literal("boardRoster") }),
  read: () => ({ type: "boardRoster" }),
  // A board member's name is the register's, not the page's writing.
  text: () => wordsOnly(""),
  editor: {
    label: "siteAdmin.editor.blocks.boardRoster",
    insert: "siteAdmin.editor.add.boardRoster",
    icon: "people",
    category: "association",
    nestable: false,
    create: () => ({ type: "boardRoster" }),
  },
});

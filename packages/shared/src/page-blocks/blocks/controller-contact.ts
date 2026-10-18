import { defineBlock } from "../definition.ts";
import { wordsOnly } from "../text-runs.ts";

/**
 * The association's own contact details as controller, and its data protection
 * officer where it has appointed one.
 *
 * A block rather than text the board types, because GDPR art. 13(1)(a) and (b)
 * require these on the notice and a typed copy would go stale the day the board
 * changed them in settings. It renders from the association row, so the notice
 * and the record of processing say the same thing by construction.
 */
export interface ControllerContactBlock {
  type: "controllerContact";
}

export const controllerContactBlock = defineBlock<ControllerContactBlock>()({
  type: "controllerContact",
  schema: (zod) => zod.strictObject({ type: zod.literal("controllerContact") }),
  read: () => ({ type: "controllerContact" }),
  // The details are the association's settings, not the page's writing.
  text: () => wordsOnly(""),
  editor: {
    label: "siteAdmin.editor.blocks.controllerContact",
    // Placed by the privacy notice screen, and kept by the page editor on
    // every save, because the notice has to say who the controller is.
    insert: null,
    icon: "contact",
    category: "association",
    nestable: false,
    create: () => ({ type: "controllerContact" }),
  },
});

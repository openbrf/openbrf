import { defineBlock } from "../definition.ts";
import {
  buttonLinkFields,
  buttonLinkText,
  isButtonLinkStarted,
  normalizeButtonLink,
  readButtonLink,
} from "../link-target.ts";
import type { LinkTarget } from "../link-target.ts";

/**
 * How a button stands out from what is around it.
 *
 *   primary    the one thing on the page the association most wants the
 *              reader to do, in the theme's accent
 *   secondary  a quieter choice beside it, outlined in the same accent
 *
 * Two and no more, and no colour of the board's own choosing: the theme decides
 * how each looks, which is what keeps a button legible in every theme.
 */
export const BUTTON_STYLES = ["primary", "secondary"] as const;

export type ButtonStyle = (typeof BUTTON_STYLES)[number];

/**
 * A call to action: a few words, and where they lead.
 *
 * A link the size of a thumb, rather than a run of a paragraph. It leads to a
 * page of the website the board chose by its id - a built-in page among them -
 * or an https address (see LinkTarget). One that leads to a page this reader
 * may not open is not shown to them at all.
 */
export interface ButtonBlock {
  type: "button";
  label: string;
  target: LinkTarget;
  style: ButtonStyle;
}

function isButtonStyle(value: unknown): value is ButtonStyle {
  return (BUTTON_STYLES as readonly unknown[]).includes(value);
}

export const buttonBlock = defineBlock<ButtonBlock>()({
  type: "button",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("button"),
      ...buttonLinkFields(zod),
      style: zod.enum(BUTTON_STYLES),
    }),
  read: (stored) => {
    const link = readButtonLink(stored);
    const style = stored["style"];
    // A style this version does not know is not guessed at: a secondary
    // button drawn as the page's primary one says something the board did not.
    return link === null || !isButtonStyle(style)
      ? null
      : { type: "button", ...link, style };
  },
  normalize: (block) => ({
    type: "button",
    ...normalizeButtonLink(block),
    style: block.style,
  }),
  text: (block) => buttonLinkText(block),
  linkTargets: (block) => [block.target],
  editor: {
    label: "siteAdmin.editor.blocks.button",
    insert: "siteAdmin.editor.add.button",
    icon: "button",
    // The board's own words, and a link like one in a paragraph. Not a layout
    // block, so it may stand in a column beside the text it follows.
    category: "text",
    nestable: true,
    create: () => ({
      type: "button",
      label: "",
      target: { kind: "page", pageId: "" },
      style: "primary",
    }),
    ready: (block) => isButtonLinkStarted(block),
  },
});

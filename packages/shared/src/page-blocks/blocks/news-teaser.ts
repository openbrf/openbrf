import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import { defineBlock } from "../definition.ts";
import { wordsOnly } from "../text-runs.ts";

/**
 * A list of the association's most recent news, on a page.
 *
 * The block carries no news in it - only how many items to show. What it
 * becomes is resolved by the renderer against the reader's own session, so a
 * page carrying this block shows a visitor with no account the public items and
 * a member theirs as well. Storing the items in the block instead would freeze
 * one reader's answer into a page every reader gets, and would put a
 * member-only headline into a public page's stored body.
 */
export interface NewsTeaserBlock {
  type: "newsTeaser";
  /** How many of the most recent items to show, newest first. */
  count: number;
}

export const newsTeaserBlock = defineBlock<NewsTeaserBlock>()({
  type: "newsTeaser",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("newsTeaser"),
      count: zod.int().min(1).max(PAGE_CONTENT_LIMITS.teaserCount),
    }),
  read: (stored) => {
    const count = stored["count"];
    // Not clamped to the nearest allowed number: a count this parser does not
    // recognise is a block written by something this renderer cannot vouch
    // for, and showing an arbitrary amount of news would be a guess about what
    // the board meant.
    return typeof count === "number" &&
      Number.isInteger(count) &&
      count >= 1 &&
      count <= PAGE_CONTENT_LIMITS.teaserCount
      ? { type: "newsTeaser", count }
      : null;
  },
  // A news item's title is scanned where it is written, not again on every
  // page that names it.
  text: () => wordsOnly(""),
  editor: {
    label: "siteAdmin.editor.blocks.newsTeaser",
    // Placed by the news screen, which owns how many items a teaser shows.
    insert: null,
    icon: "news",
    category: "association",
    nestable: false,
    create: () => ({ type: "newsTeaser", count: 3 }),
  },
});

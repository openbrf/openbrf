import type { NewsBlock, NewsContent } from "./news-api";

/**
 * The board's text, and the blocks the platform stores.
 *
 * A news item's body is stored as a block list, never as markup, because that
 * is what lets the renderer rather than the writer decide what reaches a
 * browser. What the board types is plain text in a box, and this file is the
 * mapping between the two - held apart from the screen so it can be read and
 * tested on its own, and so the day a richer editor arrives it is the only
 * thing that changes.
 *
 * The mapping is deliberately tiny. A blank line starts a paragraph, and a line
 * beginning with two number signs is a subheading; there is no third rule and
 * no syntax for a link, because every mark that is not written down here is a
 * mark a board member could type by accident and be surprised by.
 */

/** What marks a line as a subheading. Two signs, then the words. */
const HEADING_PREFIX = "##";

/** The one heading level a news item uses: its title is the h1 above it. */
const HEADING_LEVEL = 2 as const;

/** Reads what the board typed into the blocks the API stores. */
export function contentFromText(text: string): NewsContent {
  const blocks: NewsBlock[] = [];

  for (const chunk of text.split(/\n\s*\n/)) {
    const trimmed = chunk.trim();
    if (trimmed === "") {
      continue;
    }

    if (trimmed.startsWith(HEADING_PREFIX)) {
      const heading = trimmed.slice(HEADING_PREFIX.length).trim();
      if (heading !== "") {
        blocks.push({
          type: "heading",
          level: HEADING_LEVEL,
          runs: [{ text: heading }],
        });
      }
      continue;
    }

    // Single newlines inside one paragraph are the board wrapping its own
    // lines, not asking for a break: a stored break would be a mark this
    // format does not have.
    blocks.push({
      type: "paragraph",
      runs: [{ text: trimmed.replaceAll(/\s*\n\s*/g, " ") }],
    });
  }

  return { blocks };
}

/**
 * Writes stored blocks back out as the text that produced them.
 *
 * Round-trips: reading an item into the editor and saving it again without
 * touching anything stores what was already there. A block this editor has no
 * spelling for - one written by a later editor - contributes nothing rather
 * than a placeholder, which is the same total disposition the parser on the
 * server has.
 */
export function textFromContent(content: NewsContent): string {
  return content.blocks
    .map((block) => {
      const text = block.runs.map((run) => run.text).join("");
      return block.type === "heading" ? `${HEADING_PREFIX} ${text}` : text;
    })
    .filter((paragraph) => paragraph.trim() !== "")
    .join("\n\n");
}

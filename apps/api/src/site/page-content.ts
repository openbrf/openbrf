/**
 * What a page's body is, on the way out of the database.
 *
 * The column is JSON written by an editor that does not exist yet, so nothing
 * here may assume the shape it finds. The parse below is total: it returns the
 * blocks it recognises and drops everything else, because a page whose body was
 * written by a newer editor - or edited by hand in the database - must render
 * less rather than render wrong.
 *
 * Blocks rather than markup is the whole safety argument for the public site. A
 * stored fragment of HTML would let whatever wrote it decide what the browser
 * runs; a block list lets the renderer decide, and the renderer emits text
 * nodes React escapes. There is no block type that can carry a script or a
 * third-party address, and adding one would be a visible change here.
 */

/** The only block the first renderer knows. The editor adds to this. */
export interface ParagraphBlock {
  type: "paragraph";
  text: string;
}

export type PageBlock = ParagraphBlock;

export interface PageContent {
  version: 1;
  blocks: PageBlock[];
}

export const PAGE_CONTENT_VERSION = 1;

/** Builds a body from plain paragraphs, for a caller that has only text. */
export function paragraphsContent(paragraphs: readonly string[]): PageContent {
  return {
    version: PAGE_CONTENT_VERSION,
    blocks: paragraphs
      .filter((text) => text.trim() !== "")
      .map((text) => ({ type: "paragraph", text })),
  };
}

/**
 * Reads a stored body back, keeping only blocks this renderer understands.
 *
 * An unreadable column yields no blocks rather than throwing: the page still
 * has a title, and a body nobody can parse is a reason to show a thin page, not
 * to take the website down.
 */
export function readPageContent(value: unknown): PageContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { version: PAGE_CONTENT_VERSION, blocks: [] };
  }

  const raw = (value as { blocks?: unknown }).blocks;
  if (!Array.isArray(raw)) {
    return { version: PAGE_CONTENT_VERSION, blocks: [] };
  }

  const blocks: PageBlock[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const block = entry as { type?: unknown; text?: unknown };
    if (block.type === "paragraph" && typeof block.text === "string") {
      blocks.push({ type: "paragraph", text: block.text });
    }
    // Every other type is skipped on purpose. See the note above: an unknown
    // block is content this renderer cannot vouch for.
  }

  return { version: PAGE_CONTENT_VERSION, blocks };
}

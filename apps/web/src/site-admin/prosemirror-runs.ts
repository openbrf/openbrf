import type { TextRun } from "../api/site";

/**
 * The mapping between the editor's document and the page's stored runs.
 *
 * This is the whole of the editor's contract with the platform, and it is a
 * pure function on both sides on purpose. What the browser edits is a rich-text
 * document; what the association stores is a block list of runs, which is what
 * lets the renderer decide what a page becomes. The editor's own state is never
 * stored - it is read out here, paragraph by paragraph, on every change.
 *
 * Anything the mapping does not recognise is dropped rather than carried
 * across. The editor is configured with a schema that has no headings, tables
 * or colours in it, so pasted formatting is already stripped before it gets
 * here; this is the second place that is true, and the one that would still
 * hold if the editor were replaced.
 */

/** A node of the editor's document, in the shape it serialises to. */
export interface EditorNode {
  type?: string;
  text?: string;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: EditorNode[];
}

/** The runs of every paragraph in the document, in order. */
export function paragraphsFromDocument(document: EditorNode): TextRun[][] {
  return (document.content ?? [])
    .filter((node) => node.type === "paragraph")
    .map((node) => (node.content ?? []).flatMap(runOf));
}

/** One document holding these paragraphs, for the editor to start from. */
export function documentFromParagraphs(
  paragraphs: readonly (readonly TextRun[])[],
): EditorNode {
  return {
    type: "doc",
    content: (paragraphs.length === 0 ? [[]] : paragraphs).map((runs) => ({
      type: "paragraph",
      // An empty paragraph carries no content key at all: a paragraph with an
      // empty text node is invalid in the editor's schema and is rejected when
      // the document is loaded.
      ...(runs.length === 0
        ? {}
        : { content: runs.filter((run) => run.text !== "").map(nodeOf) }),
    })),
  };
}

/** Where the caret is after a change: which paragraph, and how far into it. */
export interface Caret {
  paragraph: number;
  offset: number;
}

/**
 * At most `max` paragraphs, the ones beyond it joined to the last that fits.
 *
 * For a page that cannot take another block: a paste of several paragraphs
 * into it would otherwise become blocks the server refuses, and the whole save
 * with them. Nothing is dropped. The text that did not fit stays in the
 * paragraph it was written into, a space apart, and the caret moves with it.
 */
export function joinParagraphsBeyond(
  paragraphs: readonly TextRun[][],
  caret: Caret,
  max: number,
): { paragraphs: TextRun[][]; caret: Caret } {
  const last = Math.max(max, 1) - 1;
  if (paragraphs.length <= last + 1) {
    return { paragraphs: [...paragraphs], caret };
  }

  const joined: TextRun[] = [];
  let offset = caret.offset;
  paragraphs.slice(last).forEach((runs, index) => {
    if (lengthOf(joined) > 0 && lengthOf(runs) > 0) {
      joined.push({ text: " " });
    }
    if (last + index === caret.paragraph) {
      offset = lengthOf(joined) + caret.offset;
    }
    joined.push(...runs);
  });

  return {
    paragraphs: [...paragraphs.slice(0, last), joined],
    caret: caret.paragraph < last ? caret : { paragraph: last, offset },
  };
}

function lengthOf(runs: readonly TextRun[]): number {
  return runs.reduce((length, run) => length + run.text.length, 0);
}

function runOf(node: EditorNode): TextRun[] {
  if (
    node.type !== "text" ||
    typeof node.text !== "string" ||
    node.text === ""
  ) {
    return [];
  }

  const marks = node.marks ?? [];
  const link = marks.find((mark) => mark.type === "link")?.attrs?.["href"];

  return [
    {
      text: node.text,
      ...(marks.some((mark) => mark.type === "bold") ? { bold: true } : {}),
      ...(marks.some((mark) => mark.type === "italic") ? { italic: true } : {}),
      ...(typeof link === "string" && link !== "" ? { link } : {}),
    },
  ];
}

function nodeOf(run: TextRun): EditorNode {
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  if (run.link !== undefined) {
    marks.push({ type: "link", attrs: { href: run.link } });
  }
  if (run.bold === true) {
    marks.push({ type: "bold" });
  }
  if (run.italic === true) {
    marks.push({ type: "italic" });
  }

  return {
    type: "text",
    text: run.text,
    ...(marks.length === 0 ? {} : { marks }),
  };
}

import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import type { Node } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Transaction,
} from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

import type { TextRun } from "../api/site";
import { QUIET_BUTTON } from "../ui/controls";
import {
  type Caret,
  documentFromParagraphs,
  type EditorNode,
  joinParagraphsBeyond,
  paragraphsFromDocument,
} from "./prosemirror-runs";

export type { Caret };

/**
 * The text editor, and the only file in the client that knows one exists.
 *
 * The registered extensions ARE the schema. There is a document, paragraphs,
 * text, bold, italic and links here and nothing else, so a heading pasted from
 * a word processor, a table, a colour, a font or an image tag is stripped as
 * the paste is parsed rather than being caught later by something. That is why
 * the list is written out one import at a time instead of taken from a bundle
 * of defaults: adding a capability to the association's website has to be a
 * visible change in a file, and this is the file.
 *
 * What leaves this component is runs, never the editor's own document. It is
 * loaded on demand, so nobody who does not open the page editor downloads it.
 */

export interface RichTextProps {
  /** The runs this block holds now. Read once, when the editor is created. */
  runs: readonly TextRun[];
  /**
   * The paragraphs the document holds after a change.
   *
   * More than one when the board pressed return: the mapping is paragraph by
   * paragraph, so splitting a paragraph in the editor splits the block. This
   * editor then keeps only the first of them, and the caller gives the others
   * blocks of their own; `caret` says which of them is being written in.
   */
  onChange: (paragraphs: TextRun[][], caret: Caret) => void;
  /** Names the editing area for a screen reader. */
  label: string;
  /**
   * Takes the focus when the editor is created, with the caret this many
   * characters in: the block a return has just split off, so the board goes on
   * writing where the caret went.
   */
  focusAt?: number;
  /**
   * How many paragraphs this block may become: one, and one more for each
   * block the page still has room for. A return past it starts nothing, and
   * pasted paragraphs past it join the last one that fits.
   */
  maxParagraphs?: number;
  /** A return or a paste was held to `maxParagraphs`, so the caller can say why. */
  onFull?: () => void;
  /**
   * Typing or a paste was held to the characters a paragraph may have, so the
   * caller can say why the text stopped or what of a paste was left out.
   *
   * Told which of the blocks the editor then reports it was held in, by their
   * place in the paragraphs `onChange` is given next: 0 is the paragraph this
   * editor goes on holding, 1 the first after it. A paste can cut a paragraph it
   * started, which is not the one it was pasted into.
   *
   * `refused` is true when nothing of the change was kept, so no `onChange`
   * follows; otherwise the text that fit is applied and `onChange` is next.
   */
  onLong?: (blocks: readonly number[], refused?: boolean) => void;
  /**
   * How the text is drawn. As a field, framed like every other field; or on
   * the page, in the website's own type with nothing around it, and the
   * buttons for bold, italic and a link over it while it is being written in.
   */
  look?: "field" | "page";
  /** What an empty paragraph on the page says it is for. */
  placeholder?: string;
}

const EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Bold,
  Italic,
  Link.configure({
    openOnClick: false,
    /*
     * The schemes a stored link may have, which is the same list the server's
     * parser enforces. Kept in step deliberately: a link the editor allowed and
     * the API refused would be a refusal the board could not act on, and the API
     * is the one that decides.
     */
    protocols: ["http", "https", "mailto"],
    HTMLAttributes: { rel: "noopener noreferrer" },
  }),
];

/** The characters one paragraph may hold: the server's bound on a run. */
const PARAGRAPH_TEXT_LIMIT = PAGE_CONTENT_LIMITS.runText;

/**
 * How far past the limit the blocks this document becomes are, together.
 *
 * Measured on the blocks rather than on the editor's paragraphs: the ones past
 * `maxParagraphs` are joined into the last that fits, a space apart, exactly as
 * joinParagraphsBeyond joins them, so that join cannot make a paragraph the
 * server refuses either. A paragraph already past the limit when it was loaded
 * counts for its excess, so it may still be shortened but not lengthened.
 */
function overflowOf(document: Node, maxParagraphs: number): number {
  return blockLengths(document, maxParagraphs).reduce(
    (sum, length) => sum + Math.max(length - PARAGRAPH_TEXT_LIMIT, 0),
    0,
  );
}

function blockLengths(document: Node, maxParagraphs: number): number[] {
  const last = Math.max(maxParagraphs, 1) - 1;
  const lengths: number[] = [];
  document.forEach((paragraph, _offset, index) => {
    const length = paragraph.textContent.length;
    if (index <= last) {
      lengths.push(length);
      return;
    }
    const joined = lengths[last] ?? 0;
    lengths[last] = joined + (joined > 0 && length > 0 ? 1 : 0) + length;
  });
  return lengths;
}

/** Whether a position falls between the two halves of a surrogate pair. */
function isSplitPair(document: Node, position: number): boolean {
  const before = document.textBetween(position - 1, position).charCodeAt(0);
  const after = document.textBetween(position, position + 1).charCodeAt(0);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}

/**
 * Cuts a paste back until no block is longer than it may be, or than it was.
 *
 * Only pasted text is cut, from the end of what was pasted into each block that
 * is too long, so the text the board had already written stays whole. `start`
 * is where the paste began; the caret is where it ended. Each block cut is added
 * to `cutIn`, by its place among the blocks. False when the paste cannot be made
 * to fit at all, and the transaction is then refused.
 */
function cutPaste(
  transaction: Transaction,
  start: number,
  maxParagraphs: number,
  allowed: number,
  cutIn: Set<number>,
): boolean {
  const last = Math.max(maxParagraphs, 1) - 1;
  let end = transaction.selection.head;
  while (overflowOf(transaction.doc, maxParagraphs) > allowed) {
    const lengths = blockLengths(transaction.doc, maxParagraphs);
    const cuts: { from: number; to: number; block: number }[] = [];
    transaction.doc.forEach((paragraph, offset, index) => {
      const excess =
        (lengths[Math.min(index, last)] ?? 0) - PARAGRAPH_TEXT_LIMIT;
      // The schema holds only text in a paragraph, so a position is a character.
      const from = Math.max(start, offset + 1);
      const to = Math.min(end, offset + 1 + paragraph.content.size);
      if (excess > 0 && to > from) {
        let cutFrom = Math.max(to - excess, from);
        // Cut a pair whole rather than leave its first half behind.
        if (cutFrom > from && isSplitPair(transaction.doc, cutFrom)) {
          cutFrom -= 1;
        }
        cuts.push({
          from: cutFrom,
          to,
          block: Math.min(index, last),
        });
      }
    });
    // The last first, so the end of the paste goes before its beginning.
    const cut = cuts.at(-1);
    if (cut === undefined) {
      return false;
    }
    const { from, to, block } = cut;
    cutIn.add(block);
    transaction.delete(from, to);
    end -= to - from;
  }
  return true;
}

type LengthHoldProps = Pick<RichTextProps, "maxParagraphs" | "onLong">;

/**
 * Holds every paragraph to the length the server takes, as a change is made.
 *
 * Not when the page is saved: a paragraph one character too long refuses the
 * whole page, and the board would be told only once they press save. Typing
 * past the limit is refused, and a paste is cut back to what fits.
 *
 * A plugin rather than an editor prop because it has to see every change -
 * typing, a paste, a drop, an autocorrection - before it is applied. It adds no
 * node or mark, so the schema above stays the whole of what a page holds.
 */
function lengthHold(props: { readonly current: LengthHoldProps }): Plugin {
  return new Plugin({
    key: LENGTH_HOLD,
    filterTransaction: (
      transaction: Transaction,
      state: EditorState,
    ): boolean => {
      if (!transaction.docChanged) {
        return true;
      }
      const max = props.current.maxParagraphs ?? Number.POSITIVE_INFINITY;
      const allowed = overflowOf(state.doc, max);
      if (overflowOf(transaction.doc, max) <= allowed) {
        return true;
      }
      if (transaction.getMeta("paste") !== true) {
        props.current.onLong?.([0], true);
        return false;
      }
      const cutIn = new Set<number>();
      const fits = cutPaste(
        transaction,
        transaction.mapping.map(state.selection.from, -1),
        max,
        allowed,
        cutIn,
      );
      // A paste cut back to what was there leaves the document as it was, and
      // the editor then reports no update for `onChange` to follow.
      if (fits && !transaction.doc.eq(state.doc)) {
        props.current.onLong?.([...cutIn].sort((a, b) => a - b));
      } else {
        props.current.onLong?.(fits ? [...cutIn] : [0], true);
      }
      return fits;
    },
  });
}

const LENGTH_HOLD = new PluginKey("holdParagraphLength");

export default function RichText({
  runs,
  onChange,
  label,
  focusAt,
  maxParagraphs = Number.POSITIVE_INFINITY,
  onFull,
  onLong,
  look = "field",
  placeholder,
}: RichTextProps): ReactElement {
  const { t } = useTranslation();
  const onPage = look === "page";

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: documentFromParagraphs([runs]) as object,
    immediatelyRender: true,
    // A document position: 1 is the start of the one paragraph's text.
    autofocus: focusAt === undefined ? false : 1 + focusAt,
    editorProps: {
      attributes: {
        "aria-label": label,
        // On the page the text is the website's paragraph and nothing more:
        // the page's own rules give it its type and its spacing.
        ...(onPage
          ? { "data-canvas-focus": "", "data-placeholder": placeholder ?? "" }
          : {
              class:
                "min-h-11 w-full rounded-control border border-line-strong bg-raised px-3 py-2 text-body text-ink",
            }),
      },
      // Refused before the editor splits anything: a return the page has no
      // block for would only be joined back with a space where it was pressed.
      handleKeyDown: (_view, event) => {
        if (event.key !== "Enter" || maxParagraphs > 1) {
          return false;
        }
        onFull?.();
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      const read = paragraphsFromDocument(current.getJSON() as EditorNode);
      // The schema holds nothing but paragraphs, so the document's child the
      // caret is in is the paragraph of the same number.
      const { $head } = current.state.selection;
      const { paragraphs, caret } = joinParagraphsBeyond(
        read,
        { paragraph: $head.index(0), offset: $head.parentOffset },
        maxParagraphs,
      );
      if (paragraphs.length < read.length) {
        onFull?.();
      }
      onChange(paragraphs, caret);
      /*
       * A return split this block, and the paragraphs after the first now
       * have editors of their own. This one stays mounted, because remounting
       * the editor being typed into drops the keyboard focus to the page, so
       * its document is cut back here to the paragraph it shows.
       */
      if (read.length > 1) {
        current.commands.setContent(
          documentFromParagraphs([paragraphs[0] ?? []]) as object,
          { emitUpdate: false },
        );
        if (caret.paragraph === 0) {
          current.commands.setTextSelection(1 + caret.offset);
        }
      }
    },
  });

  // The editor is created once, so what the length hold reads of the props it
  // reads through here. Registered as the editor is mounted, before anything
  // can be typed into it.
  const current = useRef<LengthHoldProps>({ maxParagraphs, onLong });
  useEffect(() => {
    current.current = { maxParagraphs, onLong };
  });
  useEffect(() => {
    if (editor === null) {
      return;
    }
    /*
     * Replaces a hold the editor already has rather than adding a second one.
     * The cleanup below cannot remove it from an editor that was destroyed
     * first, and the effect then runs again for the same editor when React
     * mounts everything twice, as the dev server does; the state would then
     * hold two instances of the one key, which it refuses.
     */
    editor.registerPlugin(lengthHold(current), (hold, plugins) => [
      ...plugins.filter((plugin) => plugin.spec.key !== LENGTH_HOLD),
      hold,
    ]);
    return () => {
      if (!editor.isDestroyed) {
        editor.unregisterPlugin(LENGTH_HOLD);
      }
    };
  }, [editor]);

  /*
   * On the page the buttons stand over the text while it is being written in
   * and are gone otherwise, so the page reads as the page. They take no focus
   * from the text when pressed with a pointer: the marks are put on what is
   * selected, and a press that moved the focus would lose the selection.
   */
  const keepFocus = onPage
    ? (event: { preventDefault: () => void }) => {
        event.preventDefault();
      }
    : undefined;

  return (
    <div className={onPage ? "group/rich relative" : "flex flex-col gap-2"}>
      <div
        role="toolbar"
        aria-label={t("siteAdmin.editor.formatting", { label })}
        className={
          onPage
            ? "absolute right-0 bottom-full z-20 mb-1 hidden items-center gap-1 rounded-control border border-line bg-raised p-0.5 shadow-raised group-focus-within/rich:flex"
            : "flex flex-wrap items-center gap-2"
        }
      >
        <button
          type="button"
          className={QUIET_BUTTON}
          aria-pressed={editor?.isActive("bold") ?? false}
          onMouseDown={keepFocus}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          {t("siteAdmin.editor.bold")}
        </button>
        <button
          type="button"
          className={QUIET_BUTTON}
          aria-pressed={editor?.isActive("italic") ?? false}
          onMouseDown={keepFocus}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          {t("siteAdmin.editor.italic")}
        </button>
        <button
          type="button"
          className={QUIET_BUTTON}
          aria-pressed={editor?.isActive("link") ?? false}
          onMouseDown={keepFocus}
          onClick={() => {
            const current = editor?.getAttributes("link")["href"];
            const answer = window.prompt(
              t("siteAdmin.editor.linkPrompt"),
              typeof current === "string" ? current : "",
            );
            if (answer === null) {
              return;
            }
            if (answer === "") {
              editor?.chain().focus().unsetLink().run();
              return;
            }
            editor?.chain().focus().setLink({ href: answer }).run();
          }}
        >
          {t("siteAdmin.editor.link")}
        </button>
      </div>

      <EditorContent editor={editor} />
    </div>
  );
}

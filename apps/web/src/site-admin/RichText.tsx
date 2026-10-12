import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TextRun } from "../api/site";
import { QUIET_BUTTON } from "../ui/controls";
import {
  documentFromParagraphs,
  type EditorNode,
  paragraphsFromDocument,
} from "./prosemirror-runs";

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

/** Where the caret is after a change: which paragraph, and how far into it. */
export interface Caret {
  paragraph: number;
  offset: number;
}

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

export default function RichText({
  runs,
  onChange,
  label,
  focusAt,
}: RichTextProps): ReactElement {
  const { t } = useTranslation();

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: documentFromParagraphs([runs]) as object,
    immediatelyRender: true,
    // A document position: 1 is the start of the one paragraph's text.
    autofocus: focusAt === undefined ? false : 1 + focusAt,
    editorProps: {
      attributes: {
        "aria-label": label,
        class:
          "min-h-11 w-full rounded-control border border-line-strong bg-raised px-3 py-2 text-body text-ink",
      },
    },
    onUpdate: ({ editor: current }) => {
      const paragraphs = paragraphsFromDocument(
        current.getJSON() as EditorNode,
      );
      // The schema holds nothing but paragraphs, so the document's child the
      // caret is in is the paragraph of the same number.
      const { $head } = current.state.selection;
      const caret = { paragraph: $head.index(0), offset: $head.parentOffset };
      onChange(paragraphs, caret);
      /*
       * A return split this block, and the paragraphs after the first now
       * have editors of their own. This one stays mounted, because remounting
       * the editor being typed into drops the keyboard focus to the page, so
       * its document is cut back here to the paragraph it shows.
       */
      if (paragraphs.length > 1) {
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={QUIET_BUTTON}
          aria-pressed={editor?.isActive("bold") ?? false}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          {t("siteAdmin.editor.bold")}
        </button>
        <button
          type="button"
          className={QUIET_BUTTON}
          aria-pressed={editor?.isActive("italic") ?? false}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          {t("siteAdmin.editor.italic")}
        </button>
        <button
          type="button"
          className={QUIET_BUTTON}
          aria-pressed={editor?.isActive("link") ?? false}
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

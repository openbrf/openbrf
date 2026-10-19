import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import { defineBlock } from "../definition.ts";
import { wordsOnly } from "../text-runs.ts";

/**
 * The association's document archive, on a page.
 *
 * The block carries no documents in it - at most the binder to narrow to. What
 * it becomes is resolved by the renderer against the reader's own account, so
 * one stored page lists the public shelf to a visitor with no session and the
 * members' shelf as well to a member. Storing the documents in the block
 * instead would freeze one reader's answer into a page every reader gets, and
 * would put a member-only title into a public page's stored body.
 *
 * There is deliberately no audience on this block. Who may read a document is a
 * property of the document, decided once in the archive, and a block that could
 * name an audience would be a second place to decide it - one that a board
 * could get wrong on a page anybody can open.
 *
 * The binder is matched exactly against the archive's own free-text category. A
 * binder nobody has filed anything in lists nothing, and the block then renders
 * as nothing: a page must not announce a shelf the association has not filled.
 */
export interface DocumentListBlock {
  type: "documentList";
  /**
   * The binder to list, or absent for every document the reader may see.
   *
   * Absent and empty are the same thing here, and the write path stores the
   * absence: a binder narrowed to "" would list nothing at all, which is not
   * what a board that cleared the field meant.
   */
  category?: string;
}

/** A binder cleared back to nothing is no binder, not a binder named "". */
function withCategory(category: string): DocumentListBlock {
  return category === ""
    ? { type: "documentList" }
    : { type: "documentList", category };
}

export const documentListBlock = defineBlock<DocumentListBlock>()({
  type: "documentList",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("documentList"),
      category: zod.string().max(PAGE_CONTENT_LIMITS.category).optional(),
    }),
  read: (stored) => {
    const category = stored["category"];
    return withCategory(
      typeof category === "string"
        ? category.trim().slice(0, PAGE_CONTENT_LIMITS.category)
        : "",
    );
  },
  normalize: (block) => withCategory((block.category ?? "").trim()),
  // The binder is the board's own writing: the page prints it as the block's
  // heading, and the editor accepts any text there, not only a category the
  // archive holds.
  text: (block) => wordsOnly(block.category ?? ""),
  editor: {
    label: "siteAdmin.editor.blocks.documentList",
    insert: "siteAdmin.editor.add.documentList",
    icon: "documents",
    category: "association",
    nestable: false,
    // A binder is not chosen here. An absent one lists every document the
    // reader may see, which is the block a board that has just inserted one
    // most often meant.
    create: () => ({ type: "documentList" }),
  },
});

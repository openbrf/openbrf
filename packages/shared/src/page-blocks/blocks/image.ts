import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import { defineBlock } from "../definition.ts";
import { wordsOnly } from "../text-runs.ts";

const LIMITS = PAGE_CONTENT_LIMITS;

/**
 * A picture, named by the id of the stored file.
 *
 * An id and never a URL. The renderer builds the address from the id through
 * the media route, which is what keeps every image on the association's own
 * origin: a block carrying a URL would be a block that could name somebody
 * else's server, and the promise that reading a page discloses a visitor's
 * address to nobody would be gone with it.
 *
 * The alternative text is required and may be empty, which is the distinction
 * HTML draws between a picture that needs no description and one nobody has
 * described.
 */
export interface ImageBlock {
  type: "image";
  mediaFileId: string;
  alt: string;
  caption?: string;
}

export const imageBlock = defineBlock<ImageBlock>()({
  type: "image",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("image"),
      mediaFileId: zod.string().min(1).max(64),
      alt: zod.string().max(LIMITS.alt),
      caption: zod.string().max(LIMITS.caption).optional(),
    }),
  read: (stored) => {
    const mediaFileId = stored["mediaFileId"];
    if (typeof mediaFileId !== "string" || mediaFileId === "") {
      return null;
    }
    const alt = stored["alt"];
    const caption = stored["caption"];
    return {
      type: "image",
      mediaFileId,
      alt: typeof alt === "string" ? alt.slice(0, LIMITS.alt) : "",
      ...(typeof caption === "string" && caption !== ""
        ? { caption: caption.slice(0, LIMITS.caption) }
        : {}),
    };
  },
  // The alternative text and the caption are published prose, whatever they
  // describe.
  text: (block) => wordsOnly([block.alt, block.caption ?? ""].join(" ").trim()),
  editor: {
    label: "siteAdmin.editor.blocks.image",
    insert: "siteAdmin.editor.add.image",
    icon: "image",
    category: "media",
    nestable: true,
    create: () => ({ type: "image", mediaFileId: "", alt: "" }),
    ready: (block) => block.mediaFileId !== "",
  },
});

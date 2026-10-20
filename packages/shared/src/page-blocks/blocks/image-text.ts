import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import { scannableRuns } from "../../scannable-text.ts";
import { defineBlock } from "../definition.ts";
import { VISIBLE_TEXT } from "../link-target.ts";
import {
  keptRuns,
  readRunList,
  runsSchema,
  type TextRun,
} from "../text-runs.ts";

const LIMITS = PAGE_CONTENT_LIMITS;

/** Which side of the text the picture stands on, on a screen wide enough. */
export const IMAGE_SIDES = ["left", "right"] as const;

export type ImageSide = (typeof IMAGE_SIDES)[number];

/**
 * A picture beside the board's own text.
 *
 * Side by side where the screen is wide enough, and the picture above the text
 * where it is not: the side is where the board wants the picture to stand, not
 * an order a telephone could keep. The text is paragraphs of runs, so a link
 * and the marks in it are the same as in any paragraph on the page.
 *
 * The picture's description is required and may not be empty, as a banner's
 * is: a picture placed to illustrate the text beside it is part of what the
 * page says.
 *
 * Text is not required. A picture chosen before anything is written beside it
 * is a block in progress, and the page keeps it rather than losing the picture
 * on the next save.
 */
export interface ImageTextBlock {
  type: "imageText";
  mediaFileId: string;
  alt: string;
  side: ImageSide;
  paragraphs: TextRun[][];
}

function isImageSide(value: unknown): value is ImageSide {
  return (IMAGE_SIDES as readonly unknown[]).includes(value);
}

/** The paragraphs that carry something, which is what is stored. */
function keptParagraphs(paragraphs: readonly TextRun[][]): TextRun[][] {
  return paragraphs
    .map((runs) => keptRuns(runs))
    .filter((runs) => runs.length > 0);
}

export const imageTextBlock = defineBlock<ImageTextBlock>()({
  type: "imageText",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("imageText"),
      mediaFileId: zod.string().min(1).max(LIMITS.id),
      alt: zod.string().max(LIMITS.alt).regex(VISIBLE_TEXT),
      side: zod.enum(IMAGE_SIDES),
      paragraphs: zod.array(runsSchema(zod)).max(LIMITS.imageTextParagraphs),
    }),
  read: (stored) => {
    const { mediaFileId, alt, side, paragraphs } = stored;
    if (
      typeof mediaFileId !== "string" ||
      mediaFileId === "" ||
      mediaFileId.length > LIMITS.id ||
      typeof alt !== "string" ||
      alt.trim() === "" ||
      !isImageSide(side)
    ) {
      return null;
    }
    return {
      type: "imageText",
      mediaFileId,
      alt: alt.trim().slice(0, LIMITS.alt),
      side,
      paragraphs: Array.isArray(paragraphs)
        ? keptParagraphs(
            paragraphs
              .slice(0, LIMITS.imageTextParagraphs)
              .map((runs) => readRunList(runs)),
          )
        : [],
    };
  },
  normalize: (block) => ({
    type: "imageText",
    mediaFileId: block.mediaFileId,
    alt: block.alt.trim(),
    side: block.side,
    paragraphs: keptParagraphs(block.paragraphs),
  }),
  text: (block) => {
    // The description first, then each paragraph: the words a reader is
    // given, in the order they are. Apart by a space, so the end of one
    // paragraph and the start of the next are not read as one number.
    const paragraphs = block.paragraphs.map((runs) => scannableRuns(runs));
    return {
      words: [block.alt, ...paragraphs.map((one) => one.words)]
        .join(" ")
        .trim(),
      addresses: paragraphs.flatMap((one) => one.addresses),
      unreadableAddress: paragraphs.some((one) => one.unreadableAddress),
    };
  },
  media: (block) => [block.mediaFileId],
  editor: {
    label: "siteAdmin.editor.blocks.imageText",
    insert: "siteAdmin.editor.add.imageText",
    icon: "imageText",
    category: "media",
    // Two things side by side already. In a column a third of the page wide
    // it would be a picture the width of a word.
    nestable: false,
    create: () => ({
      type: "imageText",
      mediaFileId: "",
      alt: "",
      side: "left",
      paragraphs: [[]],
    }),
    ready: (block) => block.mediaFileId !== "",
  },
});

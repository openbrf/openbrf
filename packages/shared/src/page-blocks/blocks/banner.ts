import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import { defineBlock } from "../definition.ts";
import {
  type ButtonLink,
  buttonLinkFields,
  buttonLinkText,
  isButtonLinkStarted,
  normalizeButtonLink,
  readButtonLink,
  VISIBLE_TEXT,
} from "../link-target.ts";

const LIMITS = PAGE_CONTENT_LIMITS;

/**
 * A large picture at the top of a page, with a heading, and optionally a short
 * text and a button.
 *
 * The picture is a stored file's id, never an address, for the reason an
 * image block's is. Its description is required and may not be empty: a banner
 * is the first thing on the page, and the one picture a reader who cannot see
 * it is most likely to be told about.
 *
 * The words sit beside the picture rather than over it. Text laid over a
 * photograph is legible only where the photograph happens to be dark or light
 * enough, and nobody choosing a picture for the stairwell's notice board can be
 * asked to check that - so the theme's own surface carries them, and the
 * contrast is the theme's to guarantee.
 */
export interface BannerBlock {
  type: "banner";
  mediaFileId: string;
  alt: string;
  heading: string;
  /** A sentence or two under the heading. Absent rather than empty. */
  text?: string;
  /** The call to action under the text. Absent rather than half-filled. */
  button?: ButtonLink;
}

/** Whether a stored string carries something besides spaces. */
function isWritten(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export const bannerBlock = defineBlock<BannerBlock>()({
  type: "banner",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("banner"),
      mediaFileId: zod.string().min(1).max(LIMITS.id),
      alt: zod.string().max(LIMITS.alt).regex(VISIBLE_TEXT),
      heading: zod.string().max(LIMITS.bannerHeading).regex(VISIBLE_TEXT),
      text: zod.string().max(LIMITS.bannerText).optional(),
      button: zod.strictObject(buttonLinkFields(zod)).optional(),
    }),
  read: (stored) => {
    const { mediaFileId, alt, heading, text } = stored;
    // The picture, its description and the heading are what a banner is, and
    // one missing any of them is not repaired into one.
    if (
      typeof mediaFileId !== "string" ||
      mediaFileId === "" ||
      mediaFileId.length > LIMITS.id ||
      !isWritten(alt) ||
      !isWritten(heading)
    ) {
      return null;
    }
    // A button that cannot be read loses the button and keeps the banner, as a
    // run whose link is not publishable keeps its words.
    const button =
      stored["button"] === undefined ? null : readButtonLink(stored["button"]);
    return {
      type: "banner",
      mediaFileId,
      alt: alt.trim().slice(0, LIMITS.alt),
      heading: heading.trim().slice(0, LIMITS.bannerHeading),
      ...(isWritten(text)
        ? { text: text.trim().slice(0, LIMITS.bannerText) }
        : {}),
      ...(button === null ? {} : { button }),
    };
  },
  normalize: (block) => {
    const text = block.text?.trim() ?? "";
    return {
      type: "banner",
      mediaFileId: block.mediaFileId,
      alt: block.alt.trim(),
      heading: block.heading.trim(),
      ...(text === "" ? {} : { text }),
      ...(block.button === undefined
        ? {}
        : { button: normalizeButtonLink(block.button) }),
    };
  },
  text: (block) => {
    // Every word of it is published: the description is read aloud, the
    // heading and the text are read by everybody, and the button's label is
    // printed on it. A button's address is published in the page's HTML.
    const button =
      block.button === undefined ? null : buttonLinkText(block.button);
    return {
      words: [block.alt, block.heading, block.text ?? "", button?.words ?? ""]
        .join(" ")
        .trim(),
      addresses: button?.addresses ?? [],
      unreadableAddress: button?.unreadableAddress ?? false,
    };
  },
  media: (block) => [block.mediaFileId],
  linkTargets: (block) =>
    block.button === undefined ? [] : [block.button.target],
  editor: {
    label: "siteAdmin.editor.blocks.banner",
    insert: "siteAdmin.editor.add.banner",
    icon: "banner",
    category: "layout",
    nestable: false,
    create: () => ({
      type: "banner",
      mediaFileId: "",
      alt: "",
      heading: "",
    }),
    // Sent once a picture is chosen, as an image block is. A banner with a
    // picture and no heading or description is then refused by the write path
    // and named, rather than left out of the save without a word.
    ready: (block) => block.mediaFileId !== "",
    // A button the board opened and wrote no label on is not sent, and the
    // banner goes without one. One with a label is sent, finished or not, so a
    // destination not chosen yet is refused and named rather than lost.
    sendable: (block) => {
      if (block.button === undefined || isButtonLinkStarted(block.button)) {
        return block;
      }
      const { button: _unfinished, ...rest } = block;
      return rest;
    },
  },
});

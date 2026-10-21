import { PAGE_CONTENT_LIMITS } from "../page-content-limits.ts";
import { scannableRuns, type ScannableText } from "../scannable-text.ts";
import { isPublishableUrl, isRecord, type Zod } from "./text-runs.ts";

const LIMITS = PAGE_CONTENT_LIMITS;

/**
 * Where a button sends the reader.
 *
 * The two kinds of destination a menu entry has, for the same reasons:
 *
 *   page  one of the website's pages, by its id: one the board wrote or a
 *         built-in page - the news, the calendar, the broker information page.
 *         Not by its address, which the board can change: a button naming the
 *         page follows it, and one naming a page that is gone, unpublished or
 *         closed to this reader is not shown at all - exactly as the menu
 *         leaves such an entry out, so a button cannot tell a visitor that a
 *         member-only page exists.
 *   url   an address somewhere else, https only. A button is an invitation
 *         printed on a page, and sending a reader over plain http would be
 *         the association handing their traffic to whoever is in between.
 *
 * A path typed by hand is not one of them. A page is chosen by its id, so there
 * is no address to mistype and no way to point a button at a path that is not a
 * page.
 */
export type LinkTarget =
  { kind: "page"; pageId: string } | { kind: "url"; url: string };

/**
 * A button's label and where it leads, as a block that is not itself a button
 * carries one - a banner's call to action.
 */
export interface ButtonLink {
  label: string;
  target: LinkTarget;
}

/**
 * The structural half of the https rule, as a published document states it.
 *
 * Written out in character classes for the reason LINK_PATTERN is: JSON
 * Schema's pattern has no flags, and the `i` flag is dropped by the conversion
 * without a word.
 */
export const HTTPS_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]:\/\//;

/** Whether an address may be a button's destination: https, and publishable. */
export function isHttpsUrl(value: string): boolean {
  return HTTPS_PATTERN.test(value) && isPublishableUrl(value);
}

/**
 * Text that carries something besides spaces.
 *
 * A pattern rather than a refine, so the rule survives the conversion to the
 * JSON Schema an action publishes.
 */
export const VISIBLE_TEXT = /\S/;

/** A destination as the write path accepts it. */
export function linkTargetSchema(zod: Zod) {
  return zod.discriminatedUnion("kind", [
    zod.strictObject({
      kind: zod.literal("page"),
      pageId: zod.string().min(1).max(LIMITS.id),
    }),
    zod.strictObject({
      kind: zod.literal("url"),
      url: zod.string().regex(HTTPS_PATTERN).refine(isHttpsUrl),
    }),
  ]);
}

/** A label and a destination as the write path accepts them. */
export function buttonLinkFields(zod: Zod) {
  return {
    label: zod.string().max(LIMITS.buttonLabel).regex(VISIBLE_TEXT),
    target: linkTargetSchema(zod),
  };
}

/**
 * A stored destination, or null when this version cannot vouch for it.
 *
 * Not repaired: a page id that is not a string, an address that is not https,
 * a kind this version does not know - each is a destination nobody here can
 * say was meant, and the button that carries it is not shown.
 */
export function readLinkTarget(raw: unknown): LinkTarget | null {
  if (!isRecord(raw)) {
    return null;
  }
  switch (raw["kind"]) {
    case "page": {
      const pageId = raw["pageId"];
      return typeof pageId === "string" &&
        pageId !== "" &&
        pageId.length <= LIMITS.id
        ? { kind: "page", pageId }
        : null;
    }
    case "url": {
      const url = raw["url"];
      return typeof url === "string" && isHttpsUrl(url)
        ? { kind: "url", url }
        : null;
    }
    default:
      return null;
  }
}

/** A stored label and destination, or null when either cannot be read. */
export function readButtonLink(raw: unknown): ButtonLink | null {
  if (!isRecord(raw)) {
    return null;
  }
  const label = raw["label"];
  const target = readLinkTarget(raw["target"]);
  if (typeof label !== "string" || label.trim() === "" || target === null) {
    return null;
  }
  return { label: label.trim().slice(0, LIMITS.buttonLabel), target };
}

/** The label as the write path stores it, trimmed. */
export function normalizeButtonLink(link: ButtonLink): ButtonLink {
  return { label: link.label.trim(), target: link.target };
}

/**
 * Whether the board has written a label, which is when a button is sent.
 *
 * Not whether it is finished. A label with no destination chosen yet is sent,
 * and refused by the write path with the block named, because a button the
 * board wrote and was not told about would vanish from the page on save. A
 * button with no label is the empty paragraph: nothing written, nothing lost.
 */
export function isButtonLinkStarted(link: ButtonLink): boolean {
  return link.label.trim() !== "";
}

/**
 * The label and the address a button publishes.
 *
 * The label is the board's writing on the page. An address typed for it is
 * published in the page's HTML exactly as a link in a paragraph is, so it is
 * scanned the same way; a page is named by an id and has no address of the
 * board's own to scan.
 */
export function buttonLinkText(link: ButtonLink): ScannableText {
  return scannableRuns([
    link.target.kind === "url"
      ? { text: link.label, link: link.target.url }
      : { text: link.label },
  ]);
}

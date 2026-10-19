import {
  isPublishableUrl,
  scannableRuns,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";
import {
  PLUGIN_BLOCK_ATTRIBUTES,
  PLUGIN_BLOCK_ELEMENTS,
  type PluginBlockElementName,
} from "@openbrf/plugin-sdk";

/**
 * What a plugin's block renders, read into something the website may print.
 *
 * A plugin's render function is the plugin's code, and what it answers with is
 * read here as data from somewhere else: whatever shape it has, this decides
 * what of it reaches a visitor's browser. Three things are true of every
 * answer that passes, and the website's own suite asserts each:
 *
 *   No script, no style and no event handler. Only the elements in
 *   PLUGIN_BLOCK_ELEMENTS are kept, an element outside them is left out with
 *   everything inside it, and only the attributes PLUGIN_BLOCK_ATTRIBUTES
 *   names are kept on each. Text is text: the renderer prints it as a React
 *   child, which escapes it.
 *
 *   No address the website would not link to itself. A link is held to the
 *   rule a run of the board's own text is - http, https, mailto or a path on
 *   this instance - and an element that loads anything (a picture, a frame, a
 *   stylesheet) is not on the list, so nothing on the page is fetched from
 *   another host.
 *
 *   No personal identity number. The publication guardrail refuses to publish
 *   a page the board wrote one on, and a plugin's block is published on the
 *   same page: one that renders something shaped like one is left off it.
 *
 * Read into a shape of this module's own rather than kept as the plugin built
 * it, so the renderer is handed plain data with no getter, prototype or
 * property it did not ask for.
 */

/** One piece of a plugin's block, as the renderer prints it. */
export type SiteBlockNode = string | SiteBlockElement;

export interface SiteBlockElement {
  tag: PluginBlockElementName;
  /** On `a`, already held to the link rule. */
  href?: string;
  /** On `time`. */
  dateTime?: string;
  /** On `th`. */
  scope?: string;
  children: SiteBlockNode[];
}

/** Why an answer was left off the page rather than printed. */
export type PluginBlockRefusal =
  "unreadable" | "too-large" | "too-deep" | "personal-identity-number";

export type PluginBlockOutput =
  | { ok: true; nodes: SiteBlockNode[] }
  | { ok: false; refusal: PluginBlockRefusal };

/**
 * How much one block may render.
 *
 * Bounds against a plugin's mistake rather than design guidance: a block is a
 * part of a page, and one that renders more than this is a page of its own.
 * Measured as JSON, which is how the answer is copied out of the plugin's
 * objects before anything here reads it.
 */
export const PLUGIN_BLOCK_OUTPUT_LIMITS = {
  bytes: 64_000,
  /** Levels of JSON, so an element and its children count two. */
  depth: 32,
} as const;

const ELEMENTS: ReadonlySet<string> = new Set(PLUGIN_BLOCK_ELEMENTS);

/**
 * The elements a reader reads on the same line as the words around them.
 *
 * Every other one - a paragraph, a list item, a table cell, a line break -
 * starts a line of its own, and the scan reads it so.
 */
const INLINE_ELEMENTS: ReadonlySet<PluginBlockElementName> = new Set([
  "strong",
  "em",
  "small",
  "code",
  "a",
  "span",
  "time",
]);

const SCOPES: ReadonlySet<string> = new Set([
  "row",
  "col",
  "rowgroup",
  "colgroup",
]);

/** A machine-readable date or time, as the time element carries one. */
const DATE_TIME = /^[0-9A-Za-z:+\-. ]{1,64}$/;

export function readPluginBlockOutput(answer: unknown): PluginBlockOutput {
  if (answer === null || answer === undefined) {
    return { ok: true, nodes: [] };
  }

  /*
   * Copied through JSON first, which settles what the answer is: getters run
   * once, here, and what they gave is what is read; a cycle, a BigInt or a
   * getter that throws makes the answer unreadable rather than throwing out of
   * the page's render; and a function, a symbol or a class instance's methods
   * are simply not there.
   */
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(answer);
  } catch {
    return { ok: false, refusal: "unreadable" };
  }
  if (serialized === undefined) {
    return { ok: false, refusal: "unreadable" };
  }
  if (serialized.length > PLUGIN_BLOCK_OUTPUT_LIMITS.bytes) {
    return { ok: false, refusal: "too-large" };
  }
  const copy: unknown = JSON.parse(serialized);
  if (!nestsWithin(copy, PLUGIN_BLOCK_OUTPUT_LIMITS.depth)) {
    return { ok: false, refusal: "too-deep" };
  }

  const nodes = readNodes(Array.isArray(copy) ? copy : [copy]);
  return carriesIdentityNumber(nodes)
    ? { ok: false, refusal: "personal-identity-number" }
    : { ok: true, nodes };
}

/**
 * Whether no array or object in a value is nested deeper than `limit`.
 *
 * A loop rather than a recursion, so the reading below - which does recurse -
 * only ever sees an answer this has already found shallow enough.
 */
function nestsWithin(value: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[value, 1]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, depth] = next;
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (depth > limit) {
      return false;
    }
    for (const child of Object.values(current)) {
      pending.push([child, depth + 1]);
    }
  }
  return true;
}

function readNodes(raw: readonly unknown[]): SiteBlockNode[] {
  const nodes: SiteBlockNode[] = [];
  for (const entry of raw) {
    const node = readNode(entry);
    if (node !== null) {
      nodes.push(node);
    }
  }
  return nodes;
}

/**
 * One node, or null to leave it out.
 *
 * A number is left out rather than turned into text, as anything else that is
 * neither text nor an element is: a plugin that meant to print one formats it
 * in the reader's language first.
 */
function readNode(raw: unknown): SiteBlockNode | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const { tag, attributes, children } = raw as {
    tag?: unknown;
    attributes?: unknown;
    children?: unknown;
  };
  if (typeof tag !== "string" || !ELEMENTS.has(tag)) {
    return null;
  }
  const name = tag as PluginBlockElementName;
  const element: SiteBlockElement = {
    tag: name,
    // A line break holds nothing; React refuses children on a void element.
    children:
      name === "br" || !Array.isArray(children) ? [] : readNodes(children),
  };
  const allowed = PLUGIN_BLOCK_ATTRIBUTES[name] ?? [];
  const given =
    typeof attributes === "object" &&
    attributes !== null &&
    !Array.isArray(attributes)
      ? (attributes as Record<string, unknown>)
      : {};
  for (const attribute of allowed) {
    const value = Object.hasOwn(given, attribute)
      ? given[attribute]
      : undefined;
    if (typeof value !== "string") {
      continue;
    }
    if (attribute === "href" && isPublishableUrl(value)) {
      element.href = value;
    } else if (attribute === "dateTime" && DATE_TIME.test(value)) {
      element.dateTime = value;
    } else if (attribute === "scope" && SCOPES.has(value)) {
      element.scope = value;
    }
  }
  return element;
}

/**
 * Whether the block carries something shaped like a personal identity number.
 *
 * Its words joined as a reader reads them, every address as written and
 * decoded, and every other attribute value kept, each on its own, by the same
 * scan the guardrail runs on the board's own writing. An attribute is printed
 * into the page's source as surely as a word is, and a date on a time element
 * is free to be shaped like a number. An address escaped too deeply to read is
 * held against the block as a number would be.
 *
 * Words in one line run together, so a number split over two spans is still
 * the number. An element that starts a line is read with a line break on each
 * side: run into the paragraph before it, a number in a paragraph of its own
 * would touch that paragraph's last digit, and the scan, which will not read a
 * number out of a longer run of digits, would let it through. The scan takes
 * the two halves of a number on two lines as the number, as a reader does.
 */
function carriesIdentityNumber(nodes: readonly SiteBlockNode[]): boolean {
  const words: string[] = [];
  const links: string[] = [];
  const values: string[] = [];
  // In document order, so the words read as a reader reads them. A recursion
  // is safe here: the depth was bounded before anything was read.
  const collect = (from: readonly SiteBlockNode[]): void => {
    for (const node of from) {
      if (typeof node === "string") {
        words.push(node);
        continue;
      }
      const { tag: _tag, children, href, ...attributes } = node;
      if (href !== undefined) {
        links.push(href);
      }
      // Every attribute but the link, so one added to the list is scanned
      // without anybody having to remember it here.
      for (const value of Object.values(attributes)) {
        if (typeof value === "string") {
          values.push(value);
        }
      }
      const ownLine = !INLINE_ELEMENTS.has(node.tag);
      if (ownLine) {
        words.push("\n");
      }
      collect(children);
      if (ownLine) {
        words.push("\n");
      }
    }
  };
  collect(nodes);
  const scanned = scannableRuns(links.map((link) => ({ text: "", link })));
  return (
    scanned.unreadableAddress ||
    [words.join(""), ...scanned.addresses, ...values].some(
      (text) => scanForPersonalIdentityNumbers(text).length > 0,
    )
  );
}

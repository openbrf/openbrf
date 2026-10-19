import type { z } from "zod";

import { PAGE_CONTENT_LIMITS } from "../page-content-limits.ts";
import type { ScannableText } from "../scannable-text.ts";

/**
 * Text runs: the one shape every piece of the board's prose on a page takes.
 *
 * Shared by every block that carries writing - a paragraph, a heading, a form's
 * intro, an answer in a FAQ - so there is one answer to what a run may be and
 * what a link in one may point at, rather than one per block.
 */

const LIMITS = PAGE_CONTENT_LIMITS;

/**
 * The WHATWG URL parser, which the browser and Node both provide. This package
 * compiles against the language alone, so the part of it read here is stated.
 */
declare const URL: new (input: string) => { readonly protocol: string };

/** The zod the caller validates with. See BlockDefinition.schema. */
export type Zod = typeof z;

/**
 * A stretch of text carrying its marks.
 *
 * Marks are flags rather than nested markup, so there is no tree here to get
 * wrong and no shape in which an attribute could reach the browser. A run is
 * the smallest piece of text whose formatting is uniform: a sentence with two
 * bold words in it is three runs, never one string with markers inside it.
 */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /**
   * Where the run links, when it links anywhere.
   *
   * Checked by isPublishableUrl on the way in and on the way out: http, https,
   * mailto, or a path on this instance. Everything else is refused by the
   * write path and dropped by the read path, so no stored page can put a
   * scheme of its own choosing into an anchor.
   */
  link?: string;
}

/**
 * The structural half of the link rule, as the published document states it.
 *
 * Exported so a spec can hold the two halves against each other: a refine is
 * erased by the JSON Schema conversion, so this pattern is all a caller reading
 * the document has, and it has to accept everything `isPublishableUrl` accepts -
 * uppercase schemes included, because `new URL` lowercases one before
 * `isPublishableUrl` sees it.
 *
 * The case is written out rather than carried by the `i` flag, and that is the
 * whole reason this looks the way it does. JSON Schema's `pattern` has no flags,
 * and `z.toJSONSchema` drops the `i` SILENTLY - so a flagged pattern accepts
 * `HTTPS://` at runtime while the document a caller reads refuses it, which is
 * the erasure rule in docs/actions.md reappearing on the one construct that was
 * supposed to survive it. Character classes survive, so the document says what
 * the service does.
 */
export const LINK_PATTERN =
  /^(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Mm][Aa][Ii][Ll][Tt][Oo]:|\/)/;

/**
 * Whether a URL may be published.
 *
 * An allowlist of schemes rather than a denylist of dangerous ones. There is no
 * end to the second kind of list - javascript:, data:, vbscript:, view-source:,
 * whatever a browser adds next - and the scheme nobody has thought of yet is
 * exactly what a denylist lets through.
 *
 * A path on this instance is allowed, written as "/nagot". A protocol-relative
 * "//exempel.se" is not: it reads as a path and resolves to another origin,
 * which is the one confusion this rule exists to prevent. Backslashes and
 * control characters are refused for a related reason - a browser normalises
 * or strips them, so a check that accepted them would be checking a different
 * string from the one that is finally fetched.
 */
export function isPublishableUrl(value: string): boolean {
  if (value === "" || value.length > LIMITS.link) {
    return false;
  }
  if (value.includes("\\") || hasControlCharacter(value)) {
    return false;
  }

  if (value.startsWith("/")) {
    return !value.startsWith("//");
  }

  let parsed: { readonly protocol: string };
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" ||
    parsed.protocol === "https:" ||
    parsed.protocol === "mailto:"
  );
}

/**
 * Whether a string carries a character a browser would strip or fold.
 *
 * Written as a scan rather than a regular expression because a class of
 * control characters is exactly what a linter flags, and rightly: this is the
 * one place where matching them is the point.
 */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });
}

/*
 * strictObject throughout, and that is the point of the write path rather than
 * a preference. z.object strips a key it does not know, which would mean a body
 * carrying a field this version has no rendering for is accepted and silently
 * loses it - the board told the platform something, the platform answered that
 * it was saved, and it was not. A refusal names the path instead, which is what
 * the exception filter turns into "invalid-body".
 */
function textRunSchema(zod: Zod) {
  return zod.strictObject({
    text: zod.string().max(LIMITS.runText),
    bold: zod.boolean().optional(),
    italic: zod.boolean().optional(),
    /*
     * The pattern and the refine both, deliberately.
     *
     * A refine is erased when this schema is converted to the JSON Schema an
     * action publishes - silently, with no marker - so a caller reading the
     * published document would be told any string is acceptable while
     * isPublishableUrl refuses javascript:, data: and protocol-relative
     * addresses. The pattern is a superset the refine still narrows: it
     * survives conversion and carries the structural half of the rule, and a
     * spec asserts that it accepts everything the refine accepts and rejects
     * those three shapes.
     *
     * Case-insensitive because the refine is: `new URL` lowercases a scheme
     * before `isPublishableUrl` reads it, so `HTTPS://exempel.se` is one of the
     * addresses the service takes. Written as character classes rather than
     * with the `i` flag, which `z.toJSONSchema` drops without saying so - see
     * LINK_PATTERN.
     */
    link: zod.string().regex(LINK_PATTERN).refine(isPublishableUrl).optional(),
  });
}

/** A list of runs as the write path accepts it. */
export function runsSchema(zod: Zod) {
  return zod.array(textRunSchema(zod)).max(LIMITS.runsPerBlock);
}

/** The runs that carry something, which is what the write path stores. */
export function keptRuns(runs: readonly TextRun[]): TextRun[] {
  return runs.filter((run) => run.text !== "");
}

/**
 * The runs of a stored text block, in either shape it may have been written in.
 *
 * A paragraph written before runs existed - `{ type: "paragraph", text }` - is
 * read as one unmarked run. Bodies already in the database are in that shape
 * and there is no migration to run.
 */
export function readRuns(stored: Readonly<Record<string, unknown>>): TextRun[] {
  const raw = stored["runs"];
  if (!Array.isArray(raw)) {
    const legacy = stored["text"];
    return typeof legacy === "string" && legacy !== ""
      ? [{ text: legacy.slice(0, LIMITS.runText) }]
      : [];
  }

  return readRunList(raw);
}

/**
 * A stored list of runs, whatever the column actually held.
 *
 * A run whose link is not publishable keeps its text and loses the link. That
 * is the read path's whole disposition in one line: show the words the board
 * wrote, never the address this version refuses to vouch for.
 *
 * Separate from readRuns because a form block's intro and a FAQ answer are
 * lists of runs under another name and with no older plain-string shape behind
 * them. Every list goes through here, so there is one answer to what a run may
 * be rather than one per field that holds them.
 */
export function readRunList(raw: unknown): TextRun[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const runs: TextRun[] = [];
  for (const entry of raw.slice(0, LIMITS.runsPerBlock)) {
    if (!isRecord(entry)) {
      continue;
    }
    const text = entry["text"];
    if (typeof text !== "string" || text === "") {
      continue;
    }
    const link = entry["link"];
    runs.push({
      text: text.slice(0, LIMITS.runText),
      ...(entry["bold"] === true ? { bold: true } : {}),
      ...(entry["italic"] === true ? { italic: true } : {}),
      ...(typeof link === "string" && isPublishableUrl(link) ? { link } : {}),
    });
  }
  return runs;
}

/** Text with no address in it. */
export function wordsOnly(words: string): ScannableText {
  return { words, addresses: [], unreadableAddress: false };
}

/** Whether a stored value is an object with keys, rather than a list or null. */
export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

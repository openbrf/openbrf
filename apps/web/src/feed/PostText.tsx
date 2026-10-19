import type { ReactElement } from "react";

/**
 * A web address in running text: http or https, up to the next space.
 *
 * Only those two schemes. A `javascript:` or `data:` address written into a
 * post is text, and stays text: a link is something a neighbour presses
 * expecting a page, and anything else behind one would be a way of making them
 * run something.
 */
const ADDRESS = /\bhttps?:\/\/[^\s<>"]+/gi;

/**
 * Punctuation that ends a sentence rather than an address.
 *
 * "Läs mer på https://example.se." links to the site, not to a page called
 * "example.se."; and an address written in parentheses keeps its closing one
 * outside. Taken off the end only, so a parenthesis inside an address is kept.
 */
const TRAILING = /[.,;:!?)\]'’]+$/;

/** One piece of a text: words, or an address to link. */
export type TextSegment =
  { kind: "text"; text: string } | { kind: "link"; href: string };

/**
 * A text cut into words and addresses.
 *
 * Exported because it is the one piece of arithmetic here, and the part worth
 * asserting on its own: what is a link and what is not decides what a neighbour
 * can be sent to by pressing.
 */
export function textSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let from = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index;
    const href = match[0].replace(TRAILING, "");
    if (start > from) {
      segments.push({ kind: "text", text: text.slice(from, start) });
    }
    segments.push({ kind: "link", href });
    from = start + href.length;
  }
  if (from < text.length) {
    segments.push({ kind: "text", text: text.slice(from) });
  }
  return segments;
}

/**
 * What somebody wrote, as they wrote it: their line breaks kept, and the web
 * addresses in it made into links.
 *
 * Plain text and nothing else. A post is not rich text and is never rendered as
 * markup, so nothing a neighbour types can change how the page around it looks;
 * the links are the one thing read out of it, and they open in a new tab with no
 * referrer, so the page a neighbour links to learns nothing about where it was
 * linked from.
 */
export function PostText({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}): ReactElement {
  return (
    <p className={`text-body break-words whitespace-pre-line ${className}`}>
      {textSegments(text).map((segment, index) =>
        segment.kind === "text" ? (
          // The index is the segment's place in a text that does not change
          // under it: a new text is a new list.
          <span key={index}>{segment.text}</span>
        ) : (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="break-all text-trust underline"
          >
            {segment.href}
          </a>
        ),
      )}
    </p>
  );
}

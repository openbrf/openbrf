import type { Principal } from "../authorization/capabilities";
import { holdsBoardSeat } from "../mail/board-recipients";
import {
  pageTextParts,
  readPageContent,
  textBlocksOnly,
} from "../site/page-content";
import type { FeedDbClient } from "./feed-audience";

/**
 * Whether this person may speak as Styrelsen in the feed: write a post as the
 * board, comment as the board, and pin what the board wrote.
 *
 * Two halves, and both are asked every time.
 *
 * **A board seat that has not ended**, asked of the register rather than read
 * off the principal, for the reason the audiences are: a boundary that trusted
 * a flag computed somewhere else would move the day the flag was cached. The
 * administrator holds every capability and no seat, so they never speak for the
 * board - an administrator is not who the house hears from when it hears from
 * Styrelsen.
 *
 * **`site:manage`**, which is what publishing in the association's name has
 * always taken. A post written as Styrelsen is a news item (ADR 0026): it can be
 * mailed to every member and published on the website, and the capability that
 * guards those acts on the news screen guards them here. Every seat holds it
 * today; asking for it as well keeps the two screens one rule if the grants
 * ever part.
 *
 * Not `chat:moderate`, which is the board answering a report rather than the
 * board saying something.
 */
export async function speaksForBoard(
  db: FeedDbClient,
  reader: Principal,
  now: Date,
): Promise<boolean> {
  return (
    reader.capabilities.has("site:manage") &&
    holdsBoardSeat(db, reader.personId, now)
  );
}

/**
 * What a news item says, as plain text: its paragraphs and headings in order,
 * a blank line between each.
 *
 * Read through the website's own parser and narrowed to prose, so the card in
 * the feed shows what the website would publish and never more.
 */
export function newsText(content: unknown): string {
  return pageTextParts(textBlocksOnly(readPageContent(content)))
    .map((part) => part.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

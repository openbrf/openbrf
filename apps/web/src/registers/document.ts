/**
 * The shape of a printed register extract.
 *
 * Class names rather than a component, deliberately. The member register and
 * the apartment register are two documents under two different rules and must
 * share no screen; sharing the measurements that make a table print correctly
 * is not sharing a screen, but sharing a component that renders either of them
 * would be one step away from it.
 *
 * The extracts sit in the room on a light surface rather than on the dark board.
 * DESIGN.md puts the register on the board and everyday lists in the room, and
 * an extract is neither: it is a document, printed and handed over, and a dark
 * panel is not what comes out of a printer. The print stylesheet in index.css
 * finishes the job by dropping the application frame.
 */

/** The printable region. The print stylesheet targets this attribute. */
export const DOCUMENT_ATTRIBUTE = { "data-print": "document" } as const;

export const DOCUMENT =
  "flex flex-col gap-5 rounded-panel border border-line bg-raised p-6 shadow-raised print:rounded-none print:border-0 print:p-0 print:shadow-none";

/** Every register column sits on the mono grid so the figures line up. */
export const CELL = "px-3 py-2 text-left align-top first:pl-0 last:pr-0";
export const HEAD_CELL = `${CELL} text-label uppercase text-ink-muted`;
export const DATA_CELL = `${CELL} font-data text-data text-ink`;
export const ROW = "border-t border-line";

/** A table wider than the page scrolls inside itself rather than the page. */
export const TABLE_SCROLL = "overflow-x-auto print:overflow-visible";
export const TABLE = "w-full border-collapse";

/** The stamp naming the document and the day it was produced. */
export const STAMP = "font-data text-data text-ink-muted";

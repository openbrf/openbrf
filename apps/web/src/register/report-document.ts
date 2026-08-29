/**
 * The shape of the printed data subject access report.
 *
 * Class names rather than a component, and its own file rather than the
 * register extracts', for the reason `registers/document.ts` states about those
 * two: documents may share the measurements that make a table print correctly,
 * and must not share a screen. This one is a third document under a third rule
 * - GDPR art. 15 rather than EFL 5 kap. or BRL 9 kap. - and it is the only one
 * of the three that carries a personal identity number. A shared component
 * rendering any of them would be one wrong argument away from printing that
 * number onto an extract that is public on request.
 *
 * The measurements are the same because paper is the same. Section headings and
 * a definition grid are this document's own: an access report is mostly
 * label-and-value rather than rows, and reads worse as a table of two columns
 * repeated fourteen times.
 */

/** The printable region. The print stylesheet in index.css targets this. */
export const DOCUMENT_ATTRIBUTE = { "data-print": "document" } as const;

export const DOCUMENT =
  "flex flex-col gap-6 rounded-panel border border-line bg-raised p-6 shadow-raised print:rounded-none print:border-0 print:p-0 print:shadow-none";

/** One section of the report. Never collapsed: a printed page has no toggles. */
export const SECTION = "flex flex-col gap-3 border-t border-line pt-4";
export const SECTION_HEADING = "text-title";

/** Label above value, the same pairing the person panel uses on screen. */
export const FIELD_GRID = "grid gap-3 sm:grid-cols-2";
export const FIELD_LABEL = "text-label uppercase text-ink-muted";
export const FIELD_VALUE = "font-data text-data text-ink";
/** Free text the association wrote: prose, so the reading face rather than mono. */
export const FIELD_TEXT = "text-body text-ink";

/** Every register column sits on the mono grid so the figures line up. */
export const CELL = "px-3 py-2 text-left align-top first:pl-0 last:pr-0";
export const HEAD_CELL = `${CELL} text-label uppercase text-ink-muted`;
export const DATA_CELL = `${CELL} font-data text-data text-ink`;
export const TEXT_CELL = `${CELL} text-body text-ink`;
export const ROW = "border-t border-line";

/** A table wider than the page scrolls inside itself rather than the page. */
export const TABLE_SCROLL = "overflow-x-auto print:overflow-visible";
export const TABLE = "w-full border-collapse";

/** The stamp naming the document and the day it was produced. */
export const STAMP = "font-data text-data text-ink-muted";

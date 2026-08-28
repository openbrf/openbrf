import type { ReactElement } from "react";

/**
 * Marks a cell whose value the register does not hold.
 *
 * Hidden from assistive technology on purpose: a table cell that is empty
 * already reads as empty, and announcing "hyphen" in every such cell of a
 * register this size is noise rather than information.
 *
 * A component rather than a dash written where it is needed, so the reason it
 * is hidden lives in one place and a screen cannot arrive at a different answer
 * for the same cell. The dash carries no language and takes no translation key;
 * what a reader is told is that the cell holds nothing, and an empty cell says
 * that in every locale.
 */
export function NotRecorded(): ReactElement {
  return <span aria-hidden="true">-</span>;
}

import type { ReactElement } from "react";

/**
 * Marks a cell the register holds no value for.
 *
 * Two renderings of one fact. A sighted reader gets a dash, which is
 * punctuation and carries no language: a column of dashes reads as a column of
 * gaps at a glance, where a word repeated down every row would only be read as
 * text. Assistive technology gets the sentence instead, because an unannounced
 * cell is indistinguishable from one whose value failed to arrive, and a
 * statutory register is the wrong document to be silent in. The dash itself
 * stays hidden so nobody hears "hyphen" once per row.
 *
 * `meaning` is required, and belongs to the column rather than to this
 * component, because an empty cell does not mean the same thing twice: a
 * tenant-ownership with no end date is still held, a membership with no exit
 * date has not ended, and an import row with no problems has none. A single
 * shared "not recorded" would be false in all three.
 */
export function NotRecorded({ meaning }: { meaning: string }): ReactElement {
  return (
    <>
      <span aria-hidden="true">-</span>
      <span className="sr-only">{meaning}</span>
    </>
  );
}

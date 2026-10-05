/**
 * What of a page's text the identity-number guardrail reads.
 *
 * Here rather than in either application because both run the guardrail: the
 * API refuses to publish a page that carries a personal identity number, and
 * the editor warns about one before the board presses save. One reading, so
 * the warning and the refusal cannot disagree about what a page carries.
 */

/** A stretch of a page's text, as far as the guardrail is concerned. */
export interface ScannableRun {
  text: string;
  link?: string;
}

/**
 * The words of a list of runs, then the addresses they link to.
 *
 * An address is published as surely as the words are: it sits in the page's
 * HTML, and a mailto: link carries whatever was typed into its subject line.
 * Each address is read decoded as well as written, so a number whose hyphen is
 * spelled %2D is still the number. The words come first, so an offset into them
 * means what it meant before links were scanned, and every piece is separated
 * by a space - a boundary to the scanner, so the end of one piece and the start
 * of the next never join into a number neither holds.
 */
export function scannableRunsText(runs: readonly ScannableRun[]): string {
  const words = runs.map((run) => run.text).join("");
  const addresses = runs.flatMap((run) =>
    run.link === undefined ? [] : addressForms(run.link),
  );
  return addresses.length === 0 ? words : [words, ...addresses].join(" ");
}

/** An address as written, and decoded when decoding changes it. */
function addressForms(link: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(link);
  } catch {
    // A stray % that begins no escape. The address is scanned as written,
    // which is also how the browser will print it.
    return [link];
  }
  return decoded === link ? [link] : [link, decoded];
}

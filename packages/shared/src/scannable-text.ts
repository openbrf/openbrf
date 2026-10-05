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
 * The text a piece of a page publishes, in the two places it is published.
 *
 * Apart rather than joined, because a refusal names where in the words a
 * number starts, and an address is not in the words: it sits in the page's
 * HTML, and no reader sees it as text. An offset into the words then means the
 * same with or without links, and a number in an address is placed by the
 * block it is in.
 */
export interface ScannableText {
  /** The words a reader sees, run after run. */
  words: string;
  /** Every address the runs link to, each as written and decoded. */
  addresses: string[];
}

/**
 * The words of a list of runs, and the addresses they link to.
 *
 * An address is published as surely as the words are: it sits in the page's
 * HTML, and a mailto: link carries whatever was typed into its subject line.
 * Each address is read decoded as well as written, so a number whose hyphen is
 * spelled %2D is still the number.
 */
export function scannableRuns(runs: readonly ScannableRun[]): ScannableText {
  return {
    words: runs.map((run) => run.text).join(""),
    addresses: runs.flatMap((run) =>
      run.link === undefined ? [] : addressForms(run.link),
    ),
  };
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

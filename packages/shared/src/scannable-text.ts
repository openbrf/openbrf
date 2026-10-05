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

/**
 * An address as written, and every reading decoding it gives.
 *
 * Decoded again until nothing changes, so a hyphen escaped twice (%252D) is
 * read as the hyphen it ends up as. Each pass ends shorter than it began, so
 * the loop ends.
 */
function addressForms(link: string): string[] {
  const forms = [link];
  let current = link;
  for (;;) {
    const decoded = decodeEscapes(current);
    if (decoded === current) {
      return forms;
    }
    forms.push(decoded);
    current = decoded;
  }
}

/**
 * Every well-formed escape in a text decoded, and everything else left alone.
 *
 * Not decodeURIComponent over the whole address, which refuses all of it for
 * one % that begins no escape - so a stray % anywhere in a link hid a number
 * spelled with %2D elsewhere in it. Each run of escapes is decoded on its own.
 * A run that is not well-formed UTF-8 has its ASCII escapes decoded one by one,
 * which is all the digits and separators of a number need.
 */
function decodeEscapes(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%[0-7][0-9A-Fa-f]/g, (escape) =>
        String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
      );
    }
  });
}

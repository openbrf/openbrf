/**
 * Characters a terminal acts on rather than prints: C0 and C1 controls (ESC
 * starts the sequences that move the cursor, retitle the window or write the
 * clipboard), the line and paragraph separators, and the bidirectional
 * overrides and isolates that reorder what is shown.
 */
const ACTED_ON = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A value this tool did not write, made safe to print on one line.
 *
 * Much of what `openbrf` prints comes from elsewhere: the catalog's listing, a
 * plugin archive's own package.json, an error a release host or npm caused. A
 * control character in any of them would reach the operator's terminal as an
 * instruction - a forged "installed" line, a new window title, a hyperlink
 * that is not what it reads as. Each one is shown as its escape instead, so it
 * is still there to see and debug from, and a tab, which does nothing worse
 * than indent, is left alone.
 */
export function terminalText(value: string): string {
  return value.replace(ACTED_ON, (character) => {
    switch (character) {
      case "\t":
        return character;
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      default: {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0xff
          ? `\\x${code.toString(16).padStart(2, "0")}`
          : `\\u${code.toString(16).padStart(4, "0")}`;
      }
    }
  });
}

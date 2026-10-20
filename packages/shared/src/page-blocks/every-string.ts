import { scannableRuns, type ScannableText } from "../scannable-text.ts";
import type { PageBlockShape } from "./definition.ts";

/**
 * Every string on a block but its type, read as words and as an address both.
 *
 * What the guardrails scan on a plugin's block, registered or not. Nobody here
 * knows which of its fields the plugin prints, or puts in an href - while it is
 * not installed, or ever, since its renderer is the plugin's own code - so all
 * of them are scanned, and a block whose markup this version does not write is
 * held to more than any block whose markup it does.
 */
export function everyStringText(block: PageBlockShape): ScannableText {
  const values = collectStrings(
    Object.entries(block)
      .filter(([field]) => field !== "type")
      .map(([, value]) => value),
  );
  const addresses = scannableRuns(
    values.map((value) => ({ text: "", link: value })),
  );
  return {
    words: values.join(" "),
    addresses: addresses.addresses,
    unreadableAddress: addresses.unreadableAddress,
  };
}

/**
 * Every string in a value, in the order it is written.
 *
 * A loop over a stack of its own rather than a recursion, because the scan
 * runs on whatever a page holds - the editor's copy of it as well as the write
 * path's - and a block nested deeper than the call stack must be scanned, not
 * throw. The depth limit refuses such a block; it does not keep it from being
 * read here first.
 */
function collectStrings(value: unknown): string[] {
  const strings: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      strings.push(current);
    } else if (typeof current === "object" && current !== null) {
      // Pushed last to first, so the first entry is the next one taken.
      const entries = Object.values(current);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        pending.push(entries[index]);
      }
    }
  }
  return strings;
}

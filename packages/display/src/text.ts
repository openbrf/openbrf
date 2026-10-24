/**
 * Shortening a text to a limit of the contract, the way the contract says:
 * ending it with "…", the ellipsis counted within the limit.
 *
 * Measured in UTF-16 code units, which is never more lenient than the
 * contract's code points, and never cutting a surrogate pair in two.
 */

const ELLIPSIS = "…";

/** The text cut to leave room for the ellipsis within `max`, and the ellipsis. */
function withEllipsis(text: string, max: number): string {
  if (max < 1) {
    return "";
  }
  let base = text.trimEnd();
  if (base.length + 1 > max) {
    let cut = max - 1;
    const last = base.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      cut -= 1;
    }
    base = base.slice(0, cut).trimEnd();
  }
  return `${base}${ELLIPSIS}`;
}

/** The text as it is when within `max`, and otherwise shortened to it with "…". */
export function shortenText(text: string, max: number): string {
  return text.length <= max ? text : withEllipsis(text, max);
}

/** Below this, the start of a further paragraph says nothing worth its room. */
const SHORTEST_FRAGMENT = 20;

/**
 * Texts that are at most `max` together: blank ones dropped, and the first one
 * that does not fit shortened with "…", or left out with the ellipsis on the
 * one before it when too little room is left to say anything.
 */
export function shortenTexts(texts: readonly string[], max: number): string[] {
  const kept: string[] = [];
  let left = max;
  for (const text of texts) {
    if (text.trim() === "") {
      continue;
    }
    if (text.length <= left) {
      kept.push(text);
      left -= text.length;
      continue;
    }
    if (left >= SHORTEST_FRAGMENT || kept.length === 0) {
      const fragment = withEllipsis(text, left);
      if (fragment !== "") {
        kept.push(fragment);
      }
    } else {
      const last = kept.pop() ?? "";
      kept.push(withEllipsis(last, last.length + left));
    }
    break;
  }
  return kept;
}

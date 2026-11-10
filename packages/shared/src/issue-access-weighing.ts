/**
 * The board's art. 15(4) weighing of an issue's text for one person's data
 * subject access report (access weighing, ADR 0057).
 *
 * A person's report carries the internal notes on the issues they reported,
 * and the case a handler recorded as concerning them that somebody else
 * reported. Either may hold words about somebody else, and the second holds
 * the reporter's own words, so art. 15(4) has the board weigh each text before
 * it is given: given whole, given in part with the words it must not give left
 * out, or left out whole, each for a stated reason. The report names the
 * reason, and never the words left out.
 *
 * Both applications read these: the server to accept a weighing and build the
 * report, the screen to offer the choices and print the reason.
 */

/**
 * Which text on the issue a weighing is about. A message and a note are named
 * by their identifier beside the part; the description and the free-text
 * location are one each.
 */
export const ISSUE_ACCESS_PARTS = [
  "DESCRIPTION",
  "LOCATION",
  "MESSAGE",
  "NOTE",
] as const;

export type IssueAccessPart = (typeof ISSUE_ACCESS_PARTS)[number];

/**
 * Why a text is left out of the report, as art. 15(4) allows (EDPB Guidelines
 * 01/2022, paras 168-174): it would tell the person who reported the case, or
 * it is about somebody else. The first is offered only for a case somebody
 * else reported: on the person's own issue they are the reporter.
 */
export const ISSUE_ACCESS_WITHHOLDING_REASONS = [
  "IDENTIFIES_REPORTER",
  "ABOUT_ANOTHER_PERSON",
] as const;

export type IssueAccessWithholdingReason =
  (typeof ISSUE_ACCESS_WITHHOLDING_REASONS)[number];

/**
 * What marks a place in a text given in part where the board left words out.
 * The report prints it where the words were, so the reader sees that, and
 * where, something is missing (EDPB Guidelines 01/2022, para 173: redact
 * rather than refuse).
 */
export const ISSUE_ACCESS_LEFT_OUT_MARK = "[…]";

/** The mark, or the same with three full stops as a keyboard writes it. */
const LEFT_OUT_MARKS = /\[(?:…|\.\.\.)\]/u;

/** A textarea answers `\n` for every line break, whatever the text was written with. */
function lines(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

function visibleLength(text: string): number {
  return text.replace(/\s/gu, "").length;
}

/**
 * Whether `copy` is `text` given in part: the text's own words, in its order,
 * with at least one place where words were left out marked
 * `ISSUE_ACCESS_LEFT_OUT_MARK`, and something of it both kept and left out.
 * The copy can take words out and never put one in, so what the report gives
 * as the case's words is always the case's words.
 *
 * Both applications hold a copy to this: the screen before it offers to save,
 * the server before it stores one.
 */
export function isGivenInPartOf(copy: string, text: string): boolean {
  const original = lines(text);
  const given = lines(copy);
  if (!LEFT_OUT_MARKS.test(given) || given === original) {
    return false;
  }
  const kept = given
    .split(LEFT_OUT_MARKS)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
  if (kept.length === 0) {
    // Nothing of it kept: that is leaving it out, which says so plainly.
    return false;
  }
  let from = 0;
  for (const piece of kept) {
    const at = original.indexOf(piece, from);
    if (at === -1) {
      return false;
    }
    from = at + piece.length;
  }
  return visibleLength(kept.join("")) < visibleLength(original);
}

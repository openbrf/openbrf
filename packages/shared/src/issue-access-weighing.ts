/**
 * The board's art. 15(4) weighing of an issue's text for one person's data
 * subject access report (access weighing, ADR 0057).
 *
 * A person's report carries the internal notes on the issues they reported,
 * and the case a handler recorded as concerning them that somebody else
 * reported. Either may hold words about somebody else, and the second holds
 * the reporter's own words, so art. 15(4) has the board weigh each text before
 * it is given: given whole, or left out for a stated reason. The report names
 * the reason, and never the words left out.
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

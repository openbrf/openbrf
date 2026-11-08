/**
 * A damage case (skadeärende, decision 28 of the issue module's plan): an
 * issue marked as an insurance damage, with the insurer, the claim number,
 * the day of the damage and its cause.
 *
 * Here rather than beside the schema, for the reason `ISSUE_REPORT_LIMITS`
 * gives: the issue screen's form has to refuse what the API refuses, and offer
 * the causes the column holds.
 */

/** What caused the damage, in the order the form offers them. */
export const ISSUE_DAMAGE_CAUSES = [
  "WATER",
  "FIRE",
  "BURGLARY",
  "VANDALISM",
  "WEATHER",
  "OTHER",
] as const;

export type IssueDamageCause = (typeof ISSUE_DAMAGE_CAUSES)[number];

/**
 * How long the insurer's name and the claim number may be. A firm's name and
 * the insurer's own label for a claim, never a paragraph: the bounds keep the
 * fields from becoming a second description.
 */
export const ISSUE_DAMAGE_CASE_LIMITS = {
  insurer: 120,
  claimNumber: 64,
} as const;

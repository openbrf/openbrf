/**
 * The published shape of a page cursor written as `state|instant|id`.
 *
 * A read action refuses a cursor it did not hand out with a refine or in the
 * service, and a refine is erased from the published document (docs/actions.md,
 * "Structural constraints first"). This pattern is the structural half: one of
 * the states, an instant as `Date.prototype.toISOString` writes it, and an id
 * without the separator. It is a superset of what the parsers take - they also
 * insist the instant reads back to itself - so the document never refuses a
 * cursor the service would have read.
 *
 * Anchored and flagless, because JSON Schema's `pattern` has no flags.
 */
export function cursorPattern(states: readonly string[]): RegExp {
  // Six digits and a sign for a year past 9999, which is what toISOString
  // writes then. No cursor will carry one; a pattern narrower than the parser
  // would still be the same defect in the other direction.
  const instant = String.raw`(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
  return new RegExp(String.raw`^(?:${states.join("|")})\|${instant}\|[^|]+$`);
}

/**
 * How much a resident may write in one issue report.
 *
 * Here rather than beside the schema that enforces them, for the reason the
 * board mailbox and page content limits give: the form has to know the same
 * numbers. A report the box accepted and the server refuses is refused after
 * the resident has written it, and a length is not something a generic error
 * can explain.
 *
 * Bounded but generous. A resident describing a leak writes a paragraph, and a
 * cap short enough to truncate one would push the detail into a second report.
 */
export const ISSUE_REPORT_LIMITS = {
  /** The free-text place in the building. */
  location: 200,
  description: 4000,
} as const;

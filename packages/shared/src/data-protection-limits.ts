/**
 * How long the free text the board writes into the data-protection records may
 * be, shared with the forms for the reason `ISSUE_REPORT_LIMITS` gives.
 */
export const DATA_PROTECTION_LIMITS = {
  /** A data-subject request's ground, its decision's, and an extension's reason. */
  requestText: 500,
  /** A breach decision's grounds, and the reasons a notification came late. */
  breachDecisionText: 1000,
} as const;

/**
 * How long the free text the board writes into the data-protection records may
 * be, shared with the forms for the reason `ISSUE_REPORT_LIMITS` gives.
 */
export const DATA_PROTECTION_LIMITS = {
  /** A data-subject request's ground, its decision's, and an extension's reason. */
  requestText: 500,
  /** A breach decision's grounds, and the reasons a notification came late. */
  breachDecisionText: 1000,
  /**
   * Who receives the data: a recipient's counterparty, the recipient the
   * consent screen names, and a processing's recipients. Long enough for the
   * hosts a plugin may declare, which fill in the first two and are written
   * into the third (`RECEIVING_HOSTS_MAX_LENGTH` in the plugin SDK).
   */
  recipientText: 2000,
} as const;

/**
 * The conversation on an issue (ärende): issue messages (svar) between the
 * reporter and the handlers, internal notes (intern anteckning) the handlers
 * write for each other, and the saved replies a handler starts a message from
 * (ADR 0054, decisions 17 to 19 of the issue module plan).
 *
 * Here rather than beside the schema, for the reason `ISSUE_REPORT_LIMITS`
 * gives: the forms have to know the same numbers and the same values.
 */

/**
 * Who wrote an issue message: the reporter, or a handler on behalf of the
 * association.
 */
export const ISSUE_MESSAGE_SIDES = ["REPORTER", "HANDLER"] as const;

export type IssueMessageSide = (typeof ISSUE_MESSAGE_SIDES)[number];

/**
 * The role a handler's message is signed with to the reporter (decision 19):
 * the board (Styrelsen) or the property manager (Förvaltaren), never a person.
 *
 * Decided when the message is written, from what the writer was then, and
 * stored with it: a role is a fact about the message, not a name, and a
 * property manager who later takes a board seat did not write as the board.
 */
export const ISSUE_SIGNATURES = ["BOARD", "PROPERTY_MANAGER"] as const;

export type IssueSignature = (typeof ISSUE_SIGNATURES)[number];

/** How much may be written in one message, note or saved reply. */
export const ISSUE_CONVERSATION_LIMITS = {
  /**
   * One issue message or internal note. The description's bound: a reply is
   * the same kind of paragraph the report was.
   */
  body: 4000,
  /** A saved reply's name, which the handler picks it by. */
  savedReplyTitle: 80,
  /** Saved replies one association keeps. A list to pick from, not an archive. */
  savedReplies: 50,
  /**
   * Files the handlers attach to one issue for each other. A bound on one
   * issue, as the reporter's six photographs are, and no defence against
   * filling the volume.
   */
  attachments: 20,
} as const;

/**
 * What a work order's delivery record says when its mail did not go out.
 *
 * Codes, never prose, on the board mailbox reply's rule: a mail server's
 * rejection quotes the envelope back, and the envelope is a contractor's
 * address. The same four a reply has, for the same four ways a sending ends
 * without a mail server's acceptance; a list of its own rather than theirs,
 * so neither module offers a screen a code the other produces.
 */
export const WORK_ORDER_DELIVERY_FAILURES = {
  /**
   * This instance has no mail server configured. The work order is on the
   * issue all the same: the handler wrote it, and what failed is the sending.
   */
  mailNotConfigured: "mail-not-configured",

  /** The mail server refused the message. */
  refused: "send-failed",

  /** The sending was given up on before any attempt reached this work order. */
  interrupted: "sending-interrupted",

  /**
   * The sending was given up on after an attempt had claimed this work order,
   * somewhere between the claim and the record of its outcome. The handler is
   * told nobody knows whether it went out, rather than that it did not: a
   * handler told the latter sends the contractor the same job twice.
   */
  unconfirmed: "delivery-unconfirmed",
} as const;

export type WorkOrderDeliveryFailure =
  (typeof WORK_ORDER_DELIVERY_FAILURES)[keyof typeof WORK_ORDER_DELIVERY_FAILURES];

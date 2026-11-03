/**
 * What a work order's delivery record says when its mail did not go out.
 *
 * Codes, never prose, on the board mailbox reply's rule: a mail server's
 * rejection quotes the envelope back, and the envelope is a contractor's
 * address. The four a reply has, for the same four ways a sending ends
 * without a mail server's acceptance, and three of its own, for a recipient or a
 * text erased, or a type ring-fenced, before the sending; a list of its own
 * rather than theirs, so neither
 * module offers a screen a code the other produces.
 */
export const WORK_ORDER_DELIVERY_FAILURES = {
  /**
   * This instance has no mail server configured. The work order is on the
   * issue all the same: the handler wrote it, and what failed is the sending.
   */
  mailNotConfigured: "mail-not-configured",

  /**
   * The mail send ended in an error other than a missing mail server. The
   * driver does not say whether the error came before or after the server took
   * the message, so this is unconfirmed, like `unconfirmed`, and is shown so.
   */
  sendErrored: "send-failed",

  /** The sending was given up on before any attempt reached this work order. */
  interrupted: "sending-interrupted",

  /**
   * The sending was given up on after an attempt had claimed this work order,
   * somewhere between the claim and the record of its outcome. The handler is
   * told nobody knows whether it went out, rather than that it did not: a
   * handler told the latter sends the contractor the same job twice.
   */
  unconfirmed: "delivery-unconfirmed",

  /**
   * The contractor was removed from the list, and erased from this work
   * order with it, before its mail went out: there is nobody left to send it
   * to.
   */
  recipientRemoved: "recipient-removed",

  /**
   * The work order's text was erased at the end of its retention period
   * before its mail went out: what the handler wrote is gone, and there is
   * nothing left to send.
   */
  textErased: "text-erased",

  /**
   * The board ring-fenced the issue's type after the work order was written
   * and before its mail went out: nothing about the issue may reach a
   * contractor any more, so it was not sent.
   */
  ringFenced: "ring-fenced",
} as const;

export type WorkOrderDeliveryFailure =
  (typeof WORK_ORDER_DELIVERY_FAILURES)[keyof typeof WORK_ORDER_DELIVERY_FAILURES];

/**
 * The failures after which nothing left this instance: no mail server, a
 * sending given up before any attempt, a recipient or text erased, a type
 * ring-fenced. `send-failed` is not among them: the mail driver says nothing
 * of whether the error came before or after the server took the message, so
 * it stays open like `delivery-unconfirmed`.
 */
const NEVER_LEFT: ReadonlySet<string> = new Set([
  WORK_ORDER_DELIVERY_FAILURES.mailNotConfigured,
  WORK_ORDER_DELIVERY_FAILURES.interrupted,
  WORK_ORDER_DELIVERY_FAILURES.recipientRemoved,
  WORK_ORDER_DELIVERY_FAILURES.textErased,
  WORK_ORDER_DELIVERY_FAILURES.ringFenced,
]);

/**
 * Whether a failed work order is known not to have gone out, as against one
 * nobody can vouch for. A data subject is told "not sent" only when it is
 * certain.
 */
export function workOrderKnownNotSent(failure: string | null): boolean {
  return failure !== null && NEVER_LEFT.has(failure);
}

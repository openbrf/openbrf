/**
 * What a work order's delivery record says when its mail did not go out.
 *
 * Codes, never prose, on the board mailbox reply's rule: a mail server's
 * rejection quotes the envelope back, and the envelope is a contractor's
 * address. The four a reply has, for the same four ways a sending ends
 * without a mail server's acceptance, and four of its own, for a recipient or a
 * text erased, a type ring-fenced, or an address unreadable, before the
 * sending; a list of its own rather than theirs, so neither module offers a
 * screen a code the other produces.
 */
export const WORK_ORDER_DELIVERY_FAILURES = {
  /**
   * This instance has no mail server configured. The work order is on the
   * issue all the same: the handler wrote it, and what failed is the sending.
   */
  mailNotConfigured: "mail-not-configured",

  /**
   * The mail send ended in an error the mail driver places before the message
   * was handed over: the mail server could not be reached, or refused the
   * sign-in, the address or the message (`MailHandover`). Nothing left this
   * instance. An error after which the server may hold the message is
   * `unconfirmed` instead.
   */
  sendErrored: "send-failed",

  /** The sending was given up on before any attempt reached this work order. */
  interrupted: "sending-interrupted",

  /**
   * Nobody knows whether the work order went out. Either the mail send ended in
   * an error after which the mail server may hold the message - a connection
   * that broke or went quiet once the message was on its way - or the sending
   * was given up on after an attempt had claimed this work order, somewhere
   * between the claim and the record of its outcome. The handler is told so,
   * rather than that it did not go out: a handler told the latter sends the
   * contractor the same job twice.
   */
  unconfirmed: "delivery-unconfirmed",

  /**
   * The recipient's address could not be read back from its encrypted copy,
   * which happens before any mail is composed. Nothing was handed to a mail
   * server, and none was asked: its own code, because `send-failed` names the
   * mail server as the reason.
   */
  recipientUnreadable: "recipient-unreadable",

  /**
   * The contractor was removed from the list, and erased from this work
   * order with it, before its mail went out: there is nobody left to send it
   * to.
   */
  recipientRemoved: "recipient-removed",

  /**
   * The work order's text was erased, at the end of its retention period or
   * by a handler's redaction, before its mail went out: what the handler wrote
   * is gone, and there is nothing left to send.
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
 * Whether each failure is one after which nothing left this instance: no mail
 * server, a mail send the driver places before the handover, a sending given up
 * before any attempt, a recipient or text erased, a type ring-fenced, an
 * address that could not be read back. Only `delivery-unconfirmed` is not.
 *
 * A record over every code, so a new failure code does not compile until it is
 * decided here, and does not silently count as unconfirmed.
 */
const NEVER_LEFT_BY_FAILURE: Record<WorkOrderDeliveryFailure, boolean> = {
  [WORK_ORDER_DELIVERY_FAILURES.mailNotConfigured]: true,
  [WORK_ORDER_DELIVERY_FAILURES.sendErrored]: true,
  [WORK_ORDER_DELIVERY_FAILURES.interrupted]: true,
  [WORK_ORDER_DELIVERY_FAILURES.recipientRemoved]: true,
  [WORK_ORDER_DELIVERY_FAILURES.recipientUnreadable]: true,
  [WORK_ORDER_DELIVERY_FAILURES.textErased]: true,
  [WORK_ORDER_DELIVERY_FAILURES.ringFenced]: true,
  [WORK_ORDER_DELIVERY_FAILURES.unconfirmed]: false,
};

/** The failure codes after which nothing left this instance. */
export const WORK_ORDER_NEVER_LEFT: readonly WorkOrderDeliveryFailure[] = (
  Object.keys(NEVER_LEFT_BY_FAILURE) as WorkOrderDeliveryFailure[]
).filter((failure) => NEVER_LEFT_BY_FAILURE[failure]);

const NEVER_LEFT: ReadonlySet<string> = new Set(WORK_ORDER_NEVER_LEFT);

/**
 * Whether a failed work order is known not to have gone out, as against one
 * nobody can vouch for. A data subject is told "not sent" only when it is
 * certain.
 */
export function workOrderKnownNotSent(failure: string | null): boolean {
  return failure !== null && NEVER_LEFT.has(failure);
}

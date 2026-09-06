/**
 * The queue the breach reminder runs on.
 *
 * Its own file so the service that enqueues a reminder and the worker that
 * sends it can share the name without either importing the other: the service
 * would otherwise pull in the mail stack to read one string.
 */
export const BREACH_REMINDER_QUEUE = "personal-data-breach-reminder";

/** What travels on the queue. One id and the clock it was scheduled against. */
export interface BreachReminderJob {
  breachId: string;
  /**
   * The discovery the reminder was computed from, as an ISO instant.
   *
   * Carried so the handler can tell its own reminder from a stale one. A
   * corrected discovery date enqueues a new job and leaves the old one on the
   * queue; when the old one fires, its payload no longer matches the row and it
   * exits. That no-op is the whole of the cancellation strategy - the queue has
   * no cancel, and adding one to send a single reminder would be a lot of
   * machinery for a message.
   */
  discoveredAt: string;
  [key: string]: unknown;
}

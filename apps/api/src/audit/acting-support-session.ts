import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The support session a request is being served for, held for the length of
 * the request (ADR 0028).
 *
 * The authorization guard establishes it and the support request interceptor
 * runs the handler inside it, so everything the handler calls - a service, a
 * transaction, the audit log - sees the same answer without being told.
 * {@link AuditLogService.record} reads it, and that is the reason it exists:
 * some audited reads write their entry on a channel fixed at the call site, and
 * an entry written while a supporter's request is served would otherwise claim
 * that the administrator did it themselves in the web interface. Read here, the
 * channel is still derived from how the caller arrived, as `ActorContext`
 * requires, and no longer depends on each call site getting it right.
 *
 * Holds the session's id and nothing else. Whose instruction the request was
 * made on is the entry's actor, which the request's principal already names.
 */
const storage = new AsyncLocalStorage<string>();

/** Runs `work` as part of the request a support session made. */
export function runForSupportSession<T>(sessionId: string, work: () => T): T {
  return storage.run(sessionId, work);
}

/** The support session whose request is being served, or null. */
export function actingSupportSession(): string | null {
  return storage.getStore() ?? null;
}

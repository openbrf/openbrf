import { AsyncLocalStorage } from "node:async_hooks";

import { isObservable, Observable } from "rxjs";

/**
 * The resident route a plugin's handler is serving, held for the length of the
 * handler's work (ADR 0051).
 *
 * The authorization guard checks that the caller of a resident route is a
 * person the address book lists to its plugin and marks the request
 * (`markResidentRoute`). The resident route interceptor serves the request
 * inside this scope, opened from that mark, and the host object reads it
 * (`residentRouteOf`): on a resident route it refuses the register reads,
 * holds `caller`, the action dispatch and the audit entry's actor to the
 * request the scope was opened for, and holds the subject of a record, an
 * audit entry or a disclosure to the caller or to a person the plugin already
 * holds a readable record about.
 *
 * The scope follows the handler's own async work, including work it leaves
 * running after it has answered, which stays narrowed. Unlike the
 * extension-call scope (`extension-call.ts`) it is not closed when the handler
 * settles: work left running can still write a record, and must still be held
 * to the same rules.
 *
 * One plugin's: code of another plugin's that runs inside the scope, a
 * listener the handler's work set off, is not on a resident route of its own
 * and answers as it would anywhere.
 */
export interface ResidentRouteScope {
  /** The plugin whose resident route is being served. */
  readonly pluginId: string;
  /** The request the route is serving, as the guard was handed it. */
  readonly request: object;
  /** The person the guard found listed to the plugin. */
  readonly personId: string;
}

const storage = new AsyncLocalStorage<ResidentRouteScope>();

/** What the guard found of a resident route's caller, by request. */
const MARKS = new WeakMap<object, Omit<ResidentRouteScope, "request">>();

/**
 * Marks a request as a resident route's whose caller the address book lists
 * to `pluginId`. The guard alone calls this, once the caller is checked.
 */
export function markResidentRoute(
  request: object,
  mark: { pluginId: string; personId: string },
): void {
  MARKS.set(request, { pluginId: mark.pluginId, personId: mark.personId });
}

/**
 * The scope to serve a resident route's request in, from the guard's mark, or
 * null for a request the guard did not mark.
 */
export function residentRouteScopeOf(
  request: object,
): ResidentRouteScope | null {
  const mark = MARKS.get(request);
  return mark === undefined ? null : { ...mark, request };
}

/** Runs `work` as part of a resident route's request. */
export function runOnResidentRoute<T>(
  scope: ResidentRouteScope,
  work: () => T,
): T {
  return storage.run(scope, work);
}

/**
 * The resident route of `pluginId` being served, or null.
 *
 * Null outside a resident route's request, and for any other plugin whose code
 * runs inside the scope.
 */
export function residentRouteOf(pluginId: string): ResidentRouteScope | null {
  const scope = storage.getStore();
  return scope?.pluginId === pluginId ? scope : null;
}

/**
 * The handler a resident route is mounted with: the plugin's own, called in
 * the scope it is called in, with what it returns kept inside that scope.
 *
 * Entering the scope when the handler is invoked does not carry into work that
 * starts later from outside it. An Observable is such work: NestJS subscribes
 * to it after the handler has returned, and a cold one runs its producer then,
 * so `defer(() => host.addressBook.residents())` would read outside the scope.
 * So an Observable the handler returns, or one an async handler resolves to, is
 * returned as an Observable of the host's whose subscription, and so the
 * producer and every emission, runs inside the scope. Any other result is
 * returned as it is.
 *
 * Refuses to call the handler at all outside a resident route's scope: the
 * route interceptor opens it for every request the guard let through, so a
 * call without one did not come through the guard's check.
 */
export function residentRouteHandler(
  pluginId: string,
  handler: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  return function servedOnResidentRoute(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const scope = residentRouteOf(pluginId);
    if (scope === null) {
      throw new Error(
        `A resident route of plugin "${pluginId}" was called outside the ` +
          "scope of the request it serves.",
      );
    }
    return heldIn(scope, Reflect.apply(handler, this, args));
  };
}

function heldIn(scope: ResidentRouteScope, result: unknown): unknown {
  if (isObservable(result)) {
    return subscribedIn(scope, result);
  }
  if (isThenable(result)) {
    // Adopted inside the scope, so a thenable's own `then` is called in it.
    return Promise.resolve(result).then((settled: unknown) =>
      isObservable(settled) ? subscribedIn(scope, settled) : settled,
    );
  }
  return result;
}

function subscribedIn<T>(
  scope: ResidentRouteScope,
  source: Observable<T>,
): Observable<T> {
  return new Observable<T>((subscriber) =>
    runOnResidentRoute(scope, () => source.subscribe(subscriber)),
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

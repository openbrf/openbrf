import { AsyncLocalStorage } from "node:async_hooks";

import { StreamableFile } from "@nestjs/common";
import { isObservable } from "rxjs";

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
 * request the scope was opened for. It holds the subject of a new record to
 * the caller, a rewrite to the caller or the person the live record it
 * replaces names, and the subject of an audit entry or a disclosure to the
 * caller or a person the plugin already holds a readable record about.
 *
 * The scope follows the handler's own async work, including work it leaves
 * running after it has answered, which stays narrowed. Unlike the
 * extension-call scope (`extension-call.ts`) it is not closed when the handler
 * settles: work left running can still write a record, and must still be held
 * to the same rules. It does not reach code of the plugin's that something
 * outside it calls: a listener on a Subject or an emitter the plugin shares
 * runs in the context of whoever emits, a job or another request, even while
 * the handler awaits it. That is register data carried round the route
 * (ADR 0051, threat 6), for catalog review.
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
 * the scope it is called in, and refused an answer that would run the plugin's
 * code after it has returned.
 *
 * The scope follows the handler's own async work, and nothing that calls into
 * the plugin from outside it. An Observable is read from outside it: NestJS
 * subscribes to it after the handler has returned, and its operators run in
 * whatever context delivers each value. Subscribing inside the scope covers a cold producer,
 * `defer(() => host.addressBook.residents())`, but not
 * `events.pipe(mergeMap(() => host.addressBook.residents()))` on a Subject the
 * plugin shares, whose operator runs when a job or another request calls
 * `events.next()`, outside the scope. A stream is the same: Fastify pulls it
 * as the response is written, after the handler has returned. So an
 * Observable, a `StreamableFile`, a stream or a `Response` the handler returns,
 * or that an async handler resolves to, is refused before anything subscribes
 * to it or reads from it, and the request fails. Any other result is returned
 * as it is.
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
    if (residentRouteOf(pluginId) === null) {
      throw new Error(
        `A resident route of plugin "${pluginId}" was called outside the ` +
          "scope of the request it serves.",
      );
    }
    const result = Reflect.apply(handler, this, args);
    if (isThenable(result)) {
      // Adopted inside the scope, so a thenable's own `then` is called in it.
      return Promise.resolve(result).then((settled: unknown) =>
        answered(pluginId, settled),
      );
    }
    return answered(pluginId, result);
  };
}

/** A handler's result, or the refusal of one that is read later. */
function answered(pluginId: string, result: unknown): unknown {
  if (readLater(result)) {
    throw new Error(
      `A resident route of plugin "${pluginId}" answered with an Observable ` +
        "or a stream, which would run the plugin's code outside the scope " +
        "of the request it serves.",
    );
  }
  return result;
}

/**
 * Whether NestJS or Fastify would read `result` after the handler returned:
 * an Observable, which NestJS subscribes to, a `StreamableFile`, and what
 * Fastify pipes as a stream, by the tests Fastify itself applies.
 */
function readLater(result: unknown): boolean {
  if (isObservable(result) || result instanceof StreamableFile) {
    return true;
  }
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const { pipe, getReader } = result as { pipe?: unknown; getReader?: unknown };
  return (
    typeof pipe === "function" ||
    typeof getReader === "function" ||
    Object.prototype.toString.call(result) === "[object Response]"
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

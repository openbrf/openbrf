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
 * the handler awaits it. So such a host call made outside every resident route
 * while one of the plugin's handlers has not yet answered fails that answer
 * (`residentRouteOfHostCall`).
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

/** An answer a resident route's handler has yet to give. */
interface PendingAnswer {
  /** Whether a host call the scope narrows was made outside it meanwhile. */
  spoiled: boolean;
}

/** The answers the resident routes of each plugin have yet to give. */
const PENDING = new Map<string, Set<PendingAnswer>>();

/**
 * The resident route of `pluginId` that a host call the scope narrows is made
 * on, or null, for the members that narrow: the register reads, the request a
 * member is handed, and the person a record, an audit entry or a disclosure
 * names.
 *
 * Such a call made outside every resident route of the plugin's fails the
 * answer of each of its resident routes whose handler has not yet answered.
 * The host cannot tell who began it: a job or a board route of the plugin's
 * own, or a listener the handler set on a Subject the plugin shares and
 * awaits, `firstValueFrom(events.pipe(mergeMap(() => residents())))`, which
 * runs in the context of whoever emits. What such a call read or learned could
 * reach the answer, so the answer is refused instead (ADR 0051). The board
 * route or the job is answered as anywhere. A call on another resident route
 * of the plugin's fails nothing: it is narrowed to that route's caller, who
 * used the plugin.
 */
export function residentRouteOfHostCall(
  pluginId: string,
): ResidentRouteScope | null {
  const scope = residentRouteOf(pluginId);
  if (scope === null) {
    for (const answer of PENDING.get(pluginId) ?? []) {
      answer.spoiled = true;
    }
  }
  return scope;
}

/** The answers of `pluginId`'s resident routes still pending. */
function pendingAnswers(pluginId: string): Set<PendingAnswer> {
  let answers = PENDING.get(pluginId);
  if (answers === undefined) {
    answers = new Set();
    PENDING.set(pluginId, answers);
  }
  return answers;
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
 * to it or reads from it, and the request fails. So is an answer that a host
 * call the scope narrows, made outside every resident route of the plugin's
 * while the handler had not yet answered, could have reached
 * (`residentRouteOfHostCall`): `firstValueFrom()` of the same pipeline, awaited
 * in the handler's body. Any other result is returned as it is.
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
    const answers = pendingAnswers(pluginId);
    const answer: PendingAnswer = { spoiled: false };
    answers.add(answer);
    let result: unknown;
    try {
      result = Reflect.apply(handler, this, args);
    } catch (cause) {
      answers.delete(answer);
      throw cause;
    }
    if (isThenable(result)) {
      // Adopted inside the scope, so a thenable's own `then` is called in it.
      return Promise.resolve(result)
        .finally(() => answers.delete(answer))
        .then((settled: unknown) => answered(pluginId, answer, settled));
    }
    answers.delete(answer);
    return answered(pluginId, answer, result);
  };
}

/** A handler's result, or the refusal of one that is read later or spoiled. */
function answered(
  pluginId: string,
  answer: PendingAnswer,
  result: unknown,
): unknown {
  if (answer.spoiled) {
    throw new Error(
      `A resident route of plugin "${pluginId}" answered while the plugin ` +
        "read the register, or used a request or named a person, outside any " +
        "resident route, which could have reached the answer.",
    );
  }
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

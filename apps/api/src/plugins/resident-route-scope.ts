import { AsyncLocalStorage } from "node:async_hooks";

import { HttpException, Logger, StreamableFile } from "@nestjs/common";
import {
  PluginResidentRouteError,
  type PluginResidentRouteRefusedMember,
} from "@openbrf/plugin-sdk";
import { isObservable } from "rxjs";

import { ResidentRouteTimedOutError } from "./plugin.errors";

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
 * waits until the plugin's handlers that have yet to answer have answered, and
 * is refused if they do not in time (`residentRouteOfHostCall`).
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

const logger = new Logger("ResidentRoute");

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
 * A request one of a plugin's other routes is serving, a board route's or a
 * device route's, held for the length of its handler's work as a resident
 * route's scope is.
 *
 * It narrows nothing. It lets a host call that passes the very request its
 * context is serving go ahead without waiting for the plugin's resident routes
 * (`residentRouteOfHostCall`): the board member acting in their own request,
 * which no resident can hold off by making a resident route slow.
 */
interface ServedRoute {
  readonly pluginId: string;
  readonly request: object;
}

const served = new AsyncLocalStorage<ServedRoute>();

/** Runs `work` as part of the request a plugin's route other than a resident one serves. */
export function runOnPluginRoute<T>(route: ServedRoute, work: () => T): T {
  return served.run(route, work);
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
 * How long a host call the scope narrows, made outside every resident route of
 * the plugin's, waits for the plugin's resident routes to answer before it is
 * refused.
 *
 * Longer than a resident route's deadline (`RESIDENT_ROUTE_DEADLINE_MS`), so a
 * handler has answered or been cut off before a call that waits for it runs
 * out of time. A handler that answers from the database answers well within
 * either, so a job or a board route of the plugin's is only held for as long
 * as such a handler works.
 */
export const RESIDENT_ROUTE_ANSWER_WAIT_MS = 5_000;

/**
 * How long a resident route's handler may take to answer before the request
 * fails with `ResidentRouteTimedOutError`, and the narrowed host calls that
 * waited for it are refused (`residentRouteOfHostCall`).
 *
 * Without it a handler that never answers, a long-poll whose event never comes
 * or one awaiting a recipient that is down, would hold off every narrowed call
 * the plugin makes elsewhere for as long as it hangs, and fail each of them, so
 * a resident who can make a route slow could keep the plugin's board routes
 * and jobs failing until the process restarts.
 */
export const RESIDENT_ROUTE_DEADLINE_MS = 4_500;

/**
 * How long after its deadline a handler whose work goes on still has narrowed
 * host calls made outside refused at once, unless its work settles first.
 *
 * A listener the handler awaits is refused at the deadline, and may go on to
 * make its next call a moment later, with the same kept board request; were
 * the handler taken as answered by then, that call would go ahead as the
 * board member. So a hung handler fails the plugin's calls elsewhere for at
 * most `RESIDENT_ROUTE_DEADLINE_MS` and this together, and not for good.
 */
export const RESIDENT_ROUTE_OVERRUN_MS = 5_000;

/**
 * How much of a resident route's deadline is left to its handler, after an
 * outbound call it waits on has run out of time, to answer
 * (`residentRouteTimeLeft`).
 */
export const RESIDENT_ROUTE_ANSWER_MARGIN_MS = 500;

/**
 * When the handler of each resident route that has yet to answer reaches its
 * deadline, by the scope it is called in, in milliseconds since the epoch.
 */
const DEADLINES = new WeakMap<ResidentRouteScope, number>();

/**
 * How long something the resident route of `pluginId` that the code runs on
 * waits on may take, so that its handler still answers within its deadline,
 * with `RESIDENT_ROUTE_ANSWER_MARGIN_MS` to spare; zero once that is past.
 * Null off a resident route, and once its handler has answered or been cut
 * off, when how long its work takes holds nothing up.
 *
 * `recipients.fetch` gives up on a recipient no later than this, so a
 * recipient that is slow or down, which the resident can name as the one the
 * route discloses to, fails the call in time for the handler to answer it,
 * rather than cutting the handler off and having the plugin's jobs and board
 * routes refused for its overrun.
 */
export function residentRouteTimeLeft(pluginId: string): number | null {
  const scope = residentRouteOf(pluginId);
  const deadline = scope === null ? undefined : DEADLINES.get(scope);
  return deadline === undefined
    ? null
    : Math.max(deadline - RESIDENT_ROUTE_ANSWER_MARGIN_MS - Date.now(), 0);
}

/** An answer a resident route's handler has yet to give. */
interface PendingAnswer {
  /**
   * Settles once the handler has answered, or failed, with true, or once its
   * deadline ran out first, with false.
   */
  readonly given: Promise<boolean>;
  /** Marks the answer given, in time or not; only the first call counts. */
  give(inTime: boolean): void;
  /** Stops holding calls for the handler: its work has settled, or overran. */
  end(): void;
}

/**
 * The answers the resident routes of each plugin have yet to give, and those
 * of handlers cut off at their deadline whose work goes on.
 */
const PENDING = new Map<string, Set<PendingAnswer>>();

/**
 * The resident route of `pluginId` that a host call the scope narrows is made
 * on, or null once it may go ahead elsewhere, for the members that narrow: the
 * register reads, the request a member is handed, and the person a record, an
 * audit entry or a disclosure names. Asked before the member does anything
 * else, and before it reads anything about the person, so that whether it is
 * refused tells the plugin nothing about them.
 *
 * Made outside every resident route of the plugin's, the call first waits for
 * the answer of each of its resident routes whose handler had yet to answer
 * when the call was made. The host cannot tell who began it: a job or a board
 * route of the plugin's own, or a listener the handler set on a Subject the
 * plugin shares and awaits,
 * `firstValueFrom(events.pipe(mergeMap(() => residents())))`, which runs in the
 * context of whoever emits. A job's or a board route's call goes ahead once
 * those handlers have answered, and nothing it reads can reach an answer
 * already given. A listener's never does while the handler awaits it, because
 * the handler cannot answer before it: the call is refused with
 * `PluginResidentRouteError` when `RESIDENT_ROUTE_ANSWER_WAIT_MS` runs out,
 * before it reads or does anything (ADR 0051). A handler begun after the call
 * was made did not set the listener that made it. A call on another resident
 * route of the plugin's does not wait: it is narrowed to that route's caller,
 * who used the plugin.
 *
 * A handler that has not answered by its deadline (`RESIDENT_ROUTE_DEADLINE_MS`)
 * counts as one that did not answer in time: its request fails, and a call
 * that waited for it is refused as above, at the deadline rather than when its
 * own wait runs out, and without waiting for the other handlers that have yet
 * to answer. The listener such a handler awaits may still be working,
 * so while the handler's work goes on a call made outside is refused at once,
 * until that work settles or `RESIDENT_ROUTE_OVERRUN_MS` runs out. A call made
 * after that does not wait for the handler.
 *
 * A listener the handler stops awaiting, racing it against a timeout for one,
 * cannot be told from a job here: its call goes ahead once the handler has
 * answered, and a listener still subscribed after the answer, or after the
 * overrun, is not held at all. That is work handed outside the scope, which
 * catalog review reads, as it reads a job's (ADR 0051, threat 6).
 *
 * A call that passes `request`, the request it acts on, made in the context of
 * a board route or a device route of the plugin's that is serving that same
 * request, does not wait (`runOnPluginRoute`). It is the board member acting
 * in their own request, and a resident who could make a resident route slow
 * could otherwise keep the plugin's board routes failing by sending one
 * request after another. A listener the handler awaits that runs in that
 * board request, because the board route emitted, and that uses that same
 * request, goes ahead too: the host cannot tell it from the board route's own
 * call, and catalog review reads it (ADR 0051). A request kept from another
 * board request never gets this far: the member refuses it at once, as the
 * work making the call does not serve it (`heldToContext`). A call that also
 * names a person, an audit entry's subject, passes no request, because whether
 * it is accepted is the address book's answer and not the board member's.
 *
 * A refusal is logged with the plugin and the member, and nothing about the
 * request or the person, so an operator can tell why the plugin's board route
 * or job failed.
 */
export async function residentRouteOfHostCall(
  pluginId: string,
  member: PluginResidentRouteRefusedMember,
  request?: unknown,
): Promise<ResidentRouteScope | null> {
  const scope = residentRouteOf(pluginId);
  if (scope !== null) {
    return scope;
  }
  const route = served.getStore();
  if (
    route?.pluginId === pluginId &&
    request !== undefined &&
    route.request === request
  ) {
    return null;
  }
  const pending = [...(PENDING.get(pluginId) ?? [])];
  if (pending.length === 0) {
    return null;
  }
  let timer: NodeJS.Timeout | undefined;
  const answered = await new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), RESIDENT_ROUTE_ANSWER_WAIT_MS);
    // Refused as soon as any handler is out of time, without waiting for the
    // rest: one that ran out already means the call is refused. Taken as
    // answered only once every one of them has answered in time.
    let unanswered = pending.length;
    for (const answer of pending) {
      void answer.given.then((inTime) => {
        if (!inTime) {
          resolve(false);
        } else if (--unanswered === 0) {
          resolve(true);
        }
      });
    }
  });
  clearTimeout(timer);
  if (!answered) {
    logger.warn(
      `Plugin "${pluginId}" called ${member} outside its resident routes ` +
        "while one of them had yet to answer, and it did not answer in " +
        "time; the call was refused.",
    );
    throw new PluginResidentRouteError(pluginId, member, true);
  }
  return null;
}

/**
 * Records the answer the handler called in `scope` has yet to give as pending,
 * with its deadline from now.
 */
function pendingAnswer(scope: ResidentRouteScope): PendingAnswer {
  let answers = PENDING.get(scope.pluginId);
  if (answers === undefined) {
    answers = new Set();
    PENDING.set(scope.pluginId, answers);
  }
  const pending = answers;
  let resolve = (_inTime: boolean): void => undefined;
  const given = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  DEADLINES.set(scope, Date.now() + RESIDENT_ROUTE_DEADLINE_MS);
  const answer: PendingAnswer = {
    given,
    give(inTime) {
      // A promise settles once, so the first of the answer and the deadline
      // is the one a waiting call is told.
      resolve(inTime);
      DEADLINES.delete(scope);
    },
    end() {
      pending.delete(answer);
    },
  };
  pending.add(answer);
  return answer;
}

/**
 * The handler a resident route is mounted with: the plugin's own, called in
 * the scope it is called in, and its answer taken inside that scope.
 *
 * The scope follows the handler's own async work, and nothing that calls into
 * the plugin from outside it. An Observable is read from outside it: NestJS
 * subscribes to it after the handler has returned, and its operators run in
 * whatever context delivers each value. Subscribing inside the scope covers a
 * cold producer, `defer(() => host.addressBook.residents())`, but not
 * `events.pipe(mergeMap(() => host.addressBook.residents()))` on a Subject the
 * plugin shares, whose operator runs when a job or another request calls
 * `events.next()`, outside the scope. A stream is the same: Fastify pulls it
 * as the response is written, after the handler has returned. So an
 * Observable, a `StreamableFile`, a stream or a `Response` the handler returns,
 * or that an async handler resolves to, is refused before anything subscribes
 * to it or reads from it, and the request fails.
 *
 * Any other answer is serialized too, after the handler has returned, and an
 * object's `toJSON` or getter is the plugin's code. So the answer is copied as
 * the JSON it would be sent as, here inside the scope, and the copy is what
 * NestJS sends: plain data, which runs nothing of the plugin's. The body of an
 * HttpException the handler throws is copied the same way, and anything else
 * it throws, or that throws while the answer is copied, is taken as an error of
 * the core's (`failed`). Only then has the handler answered, and a narrowed
 * host call made outside the scope that waited for it goes ahead
 * (`residentRouteOfHostCall`).
 *
 * An async handler that has not answered by `RESIDENT_ROUTE_DEADLINE_MS` is
 * not waited for any longer: the request fails with
 * `ResidentRouteTimedOutError`, and a call that waited for the handler is
 * refused. What the handler answers later is dropped. Its work goes on, inside
 * the scope, as work it leaves running after an answer does.
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
    const answer = pendingAnswer(scope);
    try {
      const result = Reflect.apply(handler, this, args);
      if (isThenable(result)) {
        // Adopted inside the scope, so a thenable's own `then` is called in
        // it, and so are the callbacks that take the answer. A failure taking
        // the answer, a getter that throws, is taken as the handler's own.
        const taken = Promise.resolve(result)
          .then((settled: unknown) => answered(pluginId, settled))
          .catch((cause: unknown) => {
            throw failed(pluginId, cause);
          });
        return inTime(pluginId, taken, answer);
      }
      const given = answered(pluginId, result);
      answer.give(true);
      answer.end();
      return given;
    } catch (cause) {
      const failure = failed(pluginId, cause);
      answer.give(true);
      answer.end();
      throw failure;
    }
  };
}

/**
 * The answer an async handler gives within its deadline, or the refusal of
 * one that does not, with `answer` marked given either way: in time once the
 * handler settles, not in time when the deadline runs out first. One cut off
 * stays pending until its work settles or overruns (`RESIDENT_ROUTE_OVERRUN_MS`).
 */
function inTime(
  pluginId: string,
  taken: Promise<unknown>,
  answer: PendingAnswer,
): Promise<unknown> {
  let deadline: NodeJS.Timeout | undefined;
  let overrun: NodeJS.Timeout | undefined;
  const settled = taken.finally(() => {
    clearTimeout(deadline);
    clearTimeout(overrun);
    answer.give(true);
    answer.end();
  });
  const cutOff = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      // Marked before the request fails, so a call that waited for the
      // handler is refused rather than let through by the failure.
      answer.give(false);
      overrun = setTimeout(() => answer.end(), RESIDENT_ROUTE_OVERRUN_MS);
      // Nothing is left to answer, so the process need not wait for it.
      overrun.unref();
      logger.warn(
        `A resident route of plugin "${pluginId}" did not answer within ` +
          `${String(RESIDENT_ROUTE_DEADLINE_MS)} ms, and its request failed.`,
      );
      reject(new ResidentRouteTimedOutError(pluginId));
    }, RESIDENT_ROUTE_DEADLINE_MS);
  });
  // The race handles a late failure of the losing side, so nothing the
  // handler throws after the deadline is left unhandled.
  return Promise.race([settled, cutOff]);
}

/**
 * A handler's result as the data it is sent as, or the refusal of one that is
 * read later.
 */
function answered(pluginId: string, result: unknown): unknown {
  if (readLater(result)) {
    throw new Error(
      `A resident route of plugin "${pluginId}" answered with an Observable ` +
        "or a stream, which would run the plugin's code outside the scope " +
        "of the request it serves.",
    );
  }
  return asData(result);
}

/**
 * What a handler threw, taken now, inside the scope, as an error of the
 * core's: what is handed on is read after the handler has returned, by
 * NestJS's exception filter, and its getters, `toJSON` and methods would be
 * the plugin's code running outside the scope.
 *
 * An HttpException keeps its status and its body, the body copied as data.
 * Anything else becomes a plain error with the failure's name, code, message
 * and stack copied as text, for the plugin error interceptor to log and answer
 * as the plugin's failure; a domain error of the core's a host call threw and
 * the handler let through is answered that way too, since its status and
 * reason would be read later. Taking either runs the plugin's code, the
 * exception's own `getResponse` and the body's `toJSON` and getters, and that
 * can throw, another HttpException included. Such a throw is never handed on:
 * the request fails as the plugin's failure.
 */
function failed(pluginId: string, cause: unknown): Error {
  try {
    if (cause instanceof HttpException) {
      const status = cause.getStatus();
      if (!Number.isInteger(status)) {
        throw new TypeError("The status is not an integer.");
      }
      return new HttpException(
        asData(cause.getResponse()) as string | Record<string, unknown>,
        status,
      );
    }
    return copiedFailure(pluginId, cause);
  } catch {
    return new Error(
      `A resident route of plugin "${pluginId}" failed with something that ` +
        "could not be taken inside the scope of the request it serves.",
    );
  }
}

/**
 * A failure that is not an HttpException as a plain error of the core's, with
 * what the plugin error interceptor logs of it copied as text.
 */
function copiedFailure(pluginId: string, cause: unknown): Error {
  const copy = new Error(`A resident route of plugin "${pluginId}" failed.`);
  if (!(cause instanceof Error)) {
    return copy;
  }
  const { name, message, stack } = cause;
  const code: unknown = (cause as { code?: unknown }).code;
  if (typeof name === "string") {
    copy.name = name;
  }
  if (typeof message === "string") {
    copy.message = message;
  }
  if (typeof code === "string") {
    Object.defineProperty(copy, "code", { value: code, enumerable: true });
  }
  copy.stack = typeof stack === "string" ? stack : undefined;
  return copy;
}

/**
 * `value` as the JSON it would be sent as, parsed back: plain objects, arrays
 * and primitives, with every `toJSON` and getter already run. A primitive is
 * already that.
 */
function asData(value: unknown): unknown {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return value;
  }
  const json = JSON.stringify(value);
  return json === undefined ? undefined : (JSON.parse(json) as unknown);
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

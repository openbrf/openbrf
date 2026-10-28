import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";

import { Injectable, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import {
  PluginRequestContextError,
  type PluginRequestMember,
} from "@openbrf/plugin-sdk";

/**
 * The request the work in progress is serving, held for the length of that
 * work (ADR 0051, update of 2026-10-28).
 *
 * Every request the application serves is handled inside this scope, opened
 * once its body is read and before any guard runs (`ServedRequestHook`). The
 * scope follows the work begun for the request: the guards, the handler and
 * what it awaits or leaves running, the exception filters, and the answer's
 * serialization. It does not reach code that something outside the request
 * calls: a job, a timer or a queue the plugin started elsewhere, or a listener
 * on a Subject or an emitter the plugin shares, which runs in the context of
 * whoever emits.
 *
 * The plugin host reads it (`heldToContext`): a host member given a request is
 * refused unless the call is made in the context serving that request, and
 * only until the response is sent or its connection closes. A request a plugin
 * kept would otherwise act, wherever it is used, for the person behind it for
 * as long as it is being served.
 *
 * Holds the request object itself, as the router hands it to the guards and the
 * handler, and nothing about it.
 */
const storage = new AsyncLocalStorage<ServingScope>();

/**
 * One request's scope. It stays open until the response is sent or its
 * connection closes (`ServedRequestHook`), because work the handler left
 * running, such as a timer, carries the scope on after that and would
 * otherwise go on passing the request for as long as it runs.
 */
interface ServingScope {
  readonly request: object;
  open: boolean;
}

/**
 * Runs `work` as part of serving `request`, in a scope that stays open: the
 * hook runs each request in a scope it closes when the response is done.
 */
export function runServingRequest<T>(request: object, work: () => T): T {
  return storage.run({ request, open: true }, work);
}

/** Whether the work in progress is serving `request`, and is not yet done. */
export function servesRequest(request: unknown): boolean {
  const scope = storage.getStore();
  return scope !== undefined && scope.open && scope.request === request;
}

/**
 * Refuses a request the work in progress is not serving, given to `member` of
 * `pluginId`'s host object.
 *
 * Synchronous, and asked of the request alone, before the member waits, reads
 * or does anything, so whether a call is refused never turns on the person
 * behind the request or on anybody the call names.
 */
export function heldToContext(
  pluginId: string,
  request: unknown,
  member: PluginRequestMember,
): void {
  if (!servesRequest(request)) {
    throw new PluginRequestContextError(pluginId, member);
  }
}

/**
 * Opens the served request's scope for every request the HTTP server handles.
 *
 * A Fastify `preHandler` hook, so that it runs after the body is read (reading
 * it runs in the socket's context, which would leave a scope opened earlier)
 * and before the router calls the first guard. Everything NestJS then does for
 * the request, and every exception filter, runs in the continuation of the
 * hook's `done`. A guard or an interceptor could not open it: neither holds
 * the work that runs before it, and a guard returns before the handler runs.
 *
 * Added while the modules initialize, after the router has mounted the routes
 * and before the server is ready, which is when Fastify gives each route the
 * hooks registered on its instance. Fastify refuses a hook added once it is
 * ready, so a scope that would be missing fails the start instead.
 */
@Injectable()
export class ServedRequestHook implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const server: unknown = this.adapterHost.httpAdapter?.getInstance?.();
    if (!isFastify(server)) {
      // An application context without an HTTP server serves no request.
      return;
    }
    server.addHook("preHandler", (request, reply, done) => {
      // A response already over, as when the client left while a middleware
      // was waiting, will not close again: its scope is never open.
      const over = reply.raw.writableFinished || reply.raw.destroyed;
      const scope: ServingScope = { request, open: !over };
      // `close` follows the end of the response as well as a connection that
      // goes first, so a request kept past either is refused wherever it is
      // passed, in the work the handler left running too.
      reply.raw.once("close", () => {
        scope.open = false;
      });
      storage.run(scope, done);
    });
  }
}

/** What `ServedRequestHook` uses of a Fastify instance. */
interface FastifyHooks {
  addHook(
    name: "preHandler",
    hook: (
      request: object,
      reply: {
        raw: Pick<EventEmitter, "once"> & {
          readonly writableFinished: boolean;
          readonly destroyed: boolean;
        };
      },
      done: () => void,
    ) => void,
  ): unknown;
}

function isFastify(server: unknown): server is FastifyHooks {
  return (
    typeof server === "object" &&
    server !== null &&
    typeof (server as { addHook?: unknown }).addHook === "function"
  );
}

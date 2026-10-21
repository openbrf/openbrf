import type { FastifyInstance } from "fastify";

import { releaseAuthenticated as dropMark } from "../actions/authenticated-request";

/**
 * Drops the mark core put on a request when its response ends.
 *
 * A plugin's route is handed the real request, and a plugin can keep a
 * reference to it. The mark is what lets it dispatch an action as the person
 * on the other end of that request, and the AI package's dispatch is recorded
 * on the `ai` channel from it. Once the response has been sent, or the client
 * has gone, nobody is on the other end any more: a request held past that
 * point dispatches nothing, rather than as somebody who is no longer there.
 *
 * The raw response's `close` event is what says so, and it covers both: Node
 * emits it after an answer has been sent and when the connection drops before
 * one was. Fastify's own `onResponse` and `onRequestAbort` do not: neither
 * runs when a client leaves after its request body was read, as from a POST
 * whose route is still working. The listener goes on before anything
 * else handles the request, and a response that is already gone by then is
 * released at once. Release is final ({@link dropMark}), so a guard that
 * finishes authenticating after the client has left marks nothing.
 */
export function registerReleaseOfAuthenticatedRequest(
  server: FastifyInstance,
): void {
  server.addHook("onRequest", async (request, reply) => {
    const response = reply.raw;
    if (response.destroyed) {
      dropMark(request);
      return;
    }
    response.once("close", () => {
      dropMark(request);
    });
  });
}

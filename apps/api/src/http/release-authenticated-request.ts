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
 * `onResponse` covers an answer that was sent; `onRequestAbort` a client that
 * left before one was.
 */
export function registerReleaseOfAuthenticatedRequest(
  server: FastifyInstance,
): void {
  server.addHook("onResponse", async (request) => {
    dropMark(request);
  });
  server.addHook("onRequestAbort", async (request) => {
    dropMark(request);
  });
}

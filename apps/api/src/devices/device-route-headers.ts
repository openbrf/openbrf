import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  askedDeviceRoutes,
  deviceRouteOfRequest,
  retiredDeviceRouteOfRequest,
} from "./device-routes";

/**
 * The headers a device route answers with, and nothing else does but a path a
 * device may still be asking (ADR 0031).
 *
 * The first CORS headers in the API. The reason there were none still holds
 * everywhere else: the session cookie rests on same-origin. It does not reach a
 * device route, which reads no cookie; what authenticates there is a header no
 * browser sends on its own, so a page on another origin can call the route only
 * with a token it already holds. A packaged TV app's origin is not known in
 * advance and is not a web origin the instance could list, so an allowlist
 * would have nothing to name.
 *
 * Sent on every answer of a device route, the 304 and the 401, 404 and 429
 * refusals included. The 401's `WWW-Authenticate` is how a web player tells
 * that its token is gone: on a refusal without these headers its page could
 * not read the answer, and would show what it had as though it could not
 * connect.
 */
export const DEVICE_ROUTE_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "ETag, Retry-After, WWW-Authenticate",
  // The device keeps its own copy.
  "cache-control": "no-store",
};

/** What the preflight adds: the methods and headers a device may send. */
const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-methods": "GET, HEAD",
  "access-control-allow-headers": "Authorization, If-None-Match",
  "access-control-max-age": "600",
};

/**
 * Adds the device route headers to every answer on a device route, and
 * answers the preflight there itself.
 *
 * Hooks rather than a guard or an interceptor, because the answers that need
 * the headers most are the ones a guard throws: the 401, the 404 of a plugin
 * that is switched off, and the 429. `Access-Control-Allow-Credentials` is
 * never sent.
 *
 * On every path a device may still ask, not only the current device routes: a
 * device given a token for a route its plugin's version no longer declares
 * goes on asking it, and has to be able to read the 401 that says its token is
 * gone. Where the plugin now mounts an ordinary route on that path, a signed-in
 * person's answer carries the headers too, and that reveals nothing: a browser
 * lets no page on another origin read an answer sent with its cookie under
 * `*` without `Allow-Credentials`.
 */
export function registerDeviceRouteHeaders(server: FastifyInstance): void {
  /*
   * The browser asks before it sends `Authorization` to another origin, and
   * the plugin may answer no method but GET and HEAD under the route, so the
   * host answers. On every path a device may still ask, whether its plugin
   * is serving or not and whether the version serving still declares it: a
   * preflight says which headers may be sent, and the request that follows is
   * answered by the guards as any other.
   */
  server.addHook("onRequest", async (request, reply) => {
    if (
      request.method !== "OPTIONS" ||
      deviceRouteOfRequest(askedDeviceRoutes(), request) === null
    ) {
      return;
    }
    withHeaders(reply, { ...DEVICE_ROUTE_HEADERS, ...PREFLIGHT_HEADERS });
    await reply.code(204).send();
  });

  server.addHook("onSend", async (request, reply, payload) => {
    if (deviceRouteOfRequest(askedDeviceRoutes(), request) !== null) {
      withHeaders(reply, DEVICE_ROUTE_HEADERS);
    }
    return payload;
  });
}

/**
 * Refuses a credential presented on a dropped device route's path that no
 * handler of the version serving matches, with the 401 the guard gives where
 * one does (ADR 0031).
 *
 * A request the router matched to no route reaches no guard: it would be
 * answered 404, which tells a device that its plugin is paused, so it would
 * keep a token that was revoked and ask with it for ever. Only while the
 * plugin is serving: a plugin that is switched off, refused or removed answers
 * 404 before a token is read, on every path a device may still ask. Thrown
 * rather than sent, so the answer goes through the application's exception
 * filters as the guard's does.
 */
export function registerRetiredDevicePathRefusal(
  server: FastifyInstance,
  options: {
    /** Whether the plugin is serving now. */
    serving: (pluginId: string) => boolean;
    /**
     * The refusal, spending the client address's budget, or null for a
     * credential that is not a device's on a path that is now the protected
     * resource.
     */
    refusal: (request: FastifyRequest) => Error | null;
  },
): void {
  server.addHook("onRequest", async (request) => {
    if (
      !request.is404 ||
      request.method === "OPTIONS" ||
      request.headers.authorization === undefined
    ) {
      return;
    }
    const retired = retiredDeviceRouteOfRequest(request);
    if (retired === null || !options.serving(retired.pluginId)) {
      return;
    }
    const refusal = options.refusal(request);
    if (refusal !== null) {
      throw refusal;
    }
  });
}

function withHeaders(
  reply: FastifyReply,
  headers: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(headers)) {
    void reply.header(name, value);
  }
}

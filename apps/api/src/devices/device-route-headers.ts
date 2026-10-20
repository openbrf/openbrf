import type { FastifyInstance, FastifyReply } from "fastify";

import { deviceRouteOfRequest, deviceRoutes } from "./device-routes";

/**
 * The headers a device route answers with, and nothing else does (ADR 0031).
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
 */
export function registerDeviceRouteHeaders(server: FastifyInstance): void {
  /*
   * The browser asks before it sends `Authorization` to another origin, and
   * the plugin may answer no method but GET and HEAD under the route, so the
   * host answers. On every declared device route, whether its plugin is
   * serving or not: a preflight says which headers may be sent, and the
   * request that follows is answered by the guards as any other.
   */
  server.addHook("onRequest", async (request, reply) => {
    if (
      request.method !== "OPTIONS" ||
      deviceRouteOfRequest(deviceRoutes(), request) === null
    ) {
      return;
    }
    withHeaders(reply, { ...DEVICE_ROUTE_HEADERS, ...PREFLIGHT_HEADERS });
    await reply.code(204).send();
  });

  server.addHook("onSend", async (request, reply, payload) => {
    if (deviceRouteOfRequest(deviceRoutes(), request) !== null) {
      withHeaders(reply, DEVICE_ROUTE_HEADERS);
    }
    return payload;
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

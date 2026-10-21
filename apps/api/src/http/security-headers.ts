import type { FastifyInstance } from "fastify";

import type { Env } from "../config/env";

/**
 * The headers every response carries unless its route set its own.
 *
 * The public site, the media route and the theme stylesheet set theirs; the
 * application's own pages and the API's answers set none, so a page on another
 * site could frame the consent screen, and a browser could guess a type the
 * answer never claimed. Same origin rather than none for framing, because
 * the page editor frames the site's own preview of a page.
 */
export function securityHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
  // Only where the instance is served over https: on a development instance
  // at http://localhost the header would be ignored, and on a real one it is
  // what keeps a browser from ever trying plain http again.
  if (env.NODE_ENV === "production" && env.APP_URL.startsWith("https:")) {
    headers["strict-transport-security"] = "max-age=31536000";
  }
  return headers;
}

/** Adds {@link securityHeaders} to every response that did not set them. */
export function registerSecurityHeaders(
  server: FastifyInstance,
  env: Env,
): void {
  const headers = Object.entries(securityHeaders(env));
  server.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of headers) {
      if (!reply.hasHeader(name)) {
        void reply.header(name, value);
      }
    }
    return payload;
  });
}

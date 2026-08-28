import { existsSync } from "node:fs";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/**
 * Serves the built React client from the API process.
 *
 * One container serves everything (decision 32), so the SPA and the API share
 * an origin. That is not only a packaging convenience: the session is an
 * http-only cookie, and a second origin would make the browser treat it as
 * cross-site and drop it.
 *
 * Registered only when OPENBRF_WEB_ROOT points at a directory that exists. In
 * development the Vite dev server serves the client and proxies /api, so the
 * variable is unset and this does nothing.
 */

const logger = new Logger("SinglePageApp");

/**
 * Requests that belong to the API and must never receive index.html.
 *
 * The request URL carries the query string and this decision is about the path
 * alone, so anything from the first `?` or `#` is cut off first. Without that,
 * `/api?x=1` would not be recognised as an API request and would be answered
 * with the client's index.html rather than with the JSON 404.
 */
export function isApiRequest(url: string): boolean {
  const separator = url.search(/[?#]/);
  const path = separator === -1 ? url : url.slice(0, separator);
  return path === "/health" || path === "/api" || path.startsWith("/api/");
}

export async function serveSinglePageApp(
  app: NestFastifyApplication,
  webRoot: string | undefined,
): Promise<void> {
  if (webRoot === undefined || webRoot === "") {
    return;
  }

  const indexPath = join(webRoot, "index.html");
  if (!existsSync(indexPath)) {
    // A misconfigured path would otherwise surface as a blank page rather than
    // as a problem with the deployment.
    throw new Error(
      `OPENBRF_WEB_ROOT is ${webRoot}, but there is no index.html there. ` +
        "Point it at the built client, or unset it to run the API alone.",
    );
  }

  await app.register(fastifyStatic, {
    root: webRoot,
    // One route per file that exists at boot, instead of a catch-all. Anything
    // the client router owns then falls through to the handler below, which is
    // what makes a deep link like /settings work on a reload.
    wildcard: false,
    // The plugin's default caching is kept deliberately: every response
    // carries max-age=0 and an ETag, so a browser revalidates and gets a 304.
    // Marking the hashed assets immutable would save those round trips, but it
    // would also mean serving index.html from a cache that outlives the deploy
    // it belongs to, and an association upgrading its own instance has no way
    // to diagnose that. One association's asset traffic does not buy the risk.
  });

  // A wildcard route rather than a not-found handler: Nest's Fastify adapter
  // owns the instance's single not-found handler, and Fastify refuses a second
  // one. Route matching ranks static paths above a wildcard, so every API
  // route, the health check and every real file still win over this.
  app
    .getHttpAdapter()
    .getInstance()
    .get("/*", (request, reply) => {
      if (isApiRequest(request.url)) {
        void reply.code(404).send({ reason: "not-found" });
        return;
      }
      // The client router resolves the path; an unknown one is its 404 to show.
      //
      // The name below is a literal, and the directory it is resolved against
      // was fixed when the static plugin was registered, so no part of the
      // request reaches the path that is read: request.url is used above to
      // choose between two responses, never to name a file. The audit rule
      // suppressed here looks for a handler that builds a path out of a
      // request parameter and cannot tell that shape from this one;
      // 91-startup-and-connection-urls.spec.ts holds the difference.
      // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
      void reply.sendFile("index.html");
    });

  logger.log(`Serving the built client from ${webRoot}`);
}

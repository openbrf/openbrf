import { existsSync } from "node:fs";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

import { APP_BASE_PATH } from "./app-base-path";

/**
 * Serves the built React client from the API process.
 *
 * One container serves everything (decision 32), so the SPA and the API share
 * an origin. That is not only a packaging convenience: the session is an
 * http-only cookie, and a second origin would make the browser treat it as
 * cross-site and drop it.
 *
 * The client lives under /app rather than at the root. The root belongs to the
 * association's own public website, which is the address residents and brokers
 * are given; the application is the door beside it. Everything that mints a URL
 * into the client - the emailed activation link, the sign-in link on the
 * website - goes through APP_BASE_PATH, and the built client is told the same
 * prefix through Vite's `base` and the router's `basepath`.
 *
 * Registered only when OPENBRF_WEB_ROOT points at a directory that exists. In
 * development the Vite dev server serves the client and proxies /api, so the
 * variable is unset and this does nothing.
 */

const logger = new Logger("SinglePageApp");

/** The path of a request URL, with any query string or fragment cut off. */
function pathOf(url: string): string {
  const separator = url.search(/[?#]/);
  return separator === -1 ? url : url.slice(0, separator);
}

/**
 * Requests that belong to the API and must never receive index.html.
 *
 * The request URL carries the query string and this decision is about the path
 * alone, so anything from the first `?` or `#` is cut off first. Without that,
 * `/api?x=1` would not be recognised as an API request and would be answered
 * with the client's index.html rather than with the JSON 404.
 */
export function isApiRequest(url: string): boolean {
  const path = pathOf(url);
  return path === "/health" || path === "/api" || path.startsWith("/api/");
}

/**
 * Requests that belong to the client and must receive index.html.
 *
 * The prefix has to match a whole path segment, which is the reason this is a
 * function and not a `startsWith`: /application-form and /apple are page
 * addresses the association may well use, and answering either of them with the
 * client would take a published page off the website.
 */
export function isAppRequest(url: string): boolean {
  const path = pathOf(url);
  return path === APP_BASE_PATH || path.startsWith(`${APP_BASE_PATH}/`);
}

/**
 * How a path the client does not own is answered.
 *
 * The website renders its own not-found page, and that renderer lives in the
 * Nest container while this route is registered on the Fastify instance
 * underneath it. It is passed in rather than imported so this module keeps
 * knowing nothing about the application graph - and so a deployment serving the
 * API alone still answers, with the plain status it has always sent.
 */
export type NotFoundRenderer = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export async function serveSinglePageApp(
  app: NestFastifyApplication,
  webRoot: string | undefined,
  renderNotFound?: NotFoundRenderer,
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
    // Under the client's own prefix, so the root is left to the website. The
    // built assets carry the same prefix in their own URLs, because Vite is
    // given it as `base` at build time.
    prefix: `${APP_BASE_PATH}/`,
    // One route per file that exists at boot, instead of a catch-all. Anything
    // the client router owns then falls through to the handler below, which is
    // what makes a deep link like /app/settings work on a reload.
    wildcard: false,
    // The plugin's default caching is kept deliberately: every response
    // carries max-age=0 and an ETag, so a browser revalidates and gets a 304.
    // Marking the hashed assets immutable would save those round trips, but it
    // would also mean serving index.html from a cache that outlives the deploy
    // it belongs to, and an association upgrading its own instance has no way
    // to diagnose that. One association's asset traffic does not buy the risk.
  });

  const fontRoot = join(webRoot, "fonts");
  if (existsSync(fontRoot)) {
    await app.register(fastifyStatic, {
      root: fontRoot,
      // At the root, not under the client's prefix, because two documents ask
      // for these files: the client, whose stylesheet is built by Vite, and the
      // public website, whose stylesheet is assembled by the API. Both name
      // /fonts/<file>.woff2, and the typefaces are served from this instance
      // rather than from a font host - a third-party font discloses every
      // visitor's address to that host on every page view.
      prefix: "/fonts/",
      wildcard: false,
      // The reply decorators are already installed by the registration above,
      // and the plugin refuses to install them twice: without this the second
      // registration throws at boot.
      decorateReply: false,
    });
  }

  const instance = app.getHttpAdapter().getInstance();

  // The client's own entry point. Exact, because /app is a path a browser is
  // sent to by an emailed link and by the website's sign-in link, and a
  // wildcard alone does not match a prefix with nothing after it.
  //
  // See the note below on why the file is named literally.
  instance.get(APP_BASE_PATH, (_request, reply) => {
    // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
    void reply.sendFile("index.html");
  });

  // Everything below the prefix that is not a file: the client router's own
  // routes, on a reload as much as on a first visit.
  //
  // See the note below on why the file is named literally.
  instance.get(`${APP_BASE_PATH}/*`, (_request, reply) => {
    // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
    void reply.sendFile("index.html");
  });

  // A wildcard route rather than a not-found handler: Nest's Fastify adapter
  // owns the instance's single not-found handler, and Fastify refuses a second
  // one. Route matching ranks static paths above a parameter and a parameter
  // above a wildcard, so every API route, the health check, every real file and
  // the website's own page route still win over this.
  instance.get("/*", async (request, reply) => {
    if (isApiRequest(request.url)) {
      void reply.code(404).send({ reason: "not-found" });
      return;
    }
    if (isAppRequest(request.url)) {
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
      return;
    }

    // Anything else is an address on the association's website that no page
    // claims. It gets the website's own not-found page, in the same shape a
    // member-only page gets, so the two cannot be told apart.
    if (renderNotFound === undefined) {
      void reply.code(404).send({ reason: "not-found" });
      return;
    }

    /*
     * Awaited, and its failure answered. The renderer reads the active theme
     * and the association's own name to draw the page, so it can fail the way
     * a database read fails. Left unawaited, a rejection would be an unhandled
     * promise and the visitor would get no response at all - a hang rather
     * than a page - on the one route a stranger is most likely to reach.
     */
    try {
      await renderNotFound(request, reply);
    } catch (cause) {
      logger.error(
        `The website's not-found page could not be rendered: ${String(cause)}`,
      );
      /*
       * The status and nothing else. What just failed is the code that reads
       * the association's name and its language in order to say anything at
       * all, so this is not the place to reach for a sentence: an English one
       * would be the wrong language for a visitor the renderer was about to
       * greet in their own, and a translated one would call the machinery that
       * has already thrown. A bare 404 is honest, and the browser has its own
       * words for it.
       */
      if (!reply.sent) {
        await reply.code(404).send();
      }
    }
  });

  logger.log(`Serving the built client from ${webRoot} under ${APP_BASE_PATH}`);
}

import { readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

import { Controller, Get, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { RequireCapability } from "../authorization/require-capability.decorator";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginNotFoundError, PluginRouteNotFoundError } from "./plugin.errors";

/**
 * What a plugin's remote entry may be built from.
 *
 * An allow-list rather than a general static file server, because this reads
 * from a directory whose contents arrived as a tarball. Anything not on this
 * list is not served at all, so a plugin cannot use its own package as a place
 * to host arbitrary files on the association's domain.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/**
 * Serves a plugin's frontend bundle.
 *
 * Module Federation loads a remote from a URL, and these files live inside an
 * installed package on the data volume rather than in the application's own
 * build output - which is the whole point: a plugin's view appears without the
 * application being rebuilt.
 *
 * Served from the application's own origin so the browser sends the session
 * cookie with the request, and behind the authorization guard so a plugin's
 * view is not readable by anyone who has not signed in.
 */
@Controller("api/plugins/:pluginId/client")
@RequireCapability("self:manage")
export class PluginAssetController {
  constructor(private readonly loader: PluginLoaderService) {}

  /*
   * A bare wildcard: Fastify's router requires the wildcard to be the last
   * character of the path and rejects the named form at start-up.
   */
  @Get("*")
  async serve(
    @Param("pluginId") pluginId: string,
    @Param("*") path: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const plugin = this.loader.get(pluginId);
    if (plugin === null || plugin.manifest.entry.client === undefined) {
      throw new PluginNotFoundError(pluginId);
    }

    // The remote entry's own directory, not the package root: a plugin serves
    // its built frontend and nothing else, so its server bundle, its locale
    // files and its package.json stay unreachable over HTTP.
    const root = resolve(
      plugin.directory,
      dirname(plugin.manifest.entry.client),
    );
    const requested = path;
    const file = resolve(root, requested);

    const inside = relative(root, file);
    if (inside === "" || inside.startsWith("..") || inside.startsWith(sep)) {
      throw new PluginRouteNotFoundError(pluginId, requested);
    }

    const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
    if (contentType === undefined) {
      throw new PluginRouteNotFoundError(pluginId, requested);
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      throw new PluginRouteNotFoundError(pluginId, requested);
    }

    // Set on the reply rather than through @Header: this handler owns the
    // response object, and a decorator that writes through Nest's own response
    // pipeline does not reach one the handler sends itself.
    //
    // A plugin's bundle is versioned by the install rather than by a hashed
    // file name, so it must not be cached across an upgrade. Revalidation
    // keeps the cost of that to a conditional request.
    await reply
      .header("cache-control", "no-cache")
      .type(contentType)
      .send(bytes);
  }
}

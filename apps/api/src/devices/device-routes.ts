import type { PluginManifest } from "@openbrf/plugin-sdk";

/**
 * Which paths on this instance are device routes (ADRs 0031 and 0050).
 *
 * A device route is a path under a plugin's own mount, or the core's display
 * route, that answers to a device token and to nothing else. Three things have
 * to agree on which paths those are: the authorization guard, which takes the device branch for them before
 * the cookie path; the response hooks, which send the CORS headers on them and
 * nowhere else; and the seal, which refuses a plugin that answers anything but
 * GET and HEAD under one. This file is the one place that decides it.
 */

/** One device route, with the absolute path it is mounted on. */
export interface DeviceRoute {
  /** The plugin that serves it, or null for the core's display route. */
  pluginId: string | null;
  /** The route's id in the manifest, which a token is issued for. */
  routeId: string;
  /** Absolute, with no trailing slash: `/api/plugin/<id>/<path>`. */
  path: string;
}

/** The route id a token for the core's display route is issued for. */
export const DISPLAY_ROUTE_ID = "display";

/**
 * The core's display route (ADR 0050), which serves the display mode.
 *
 * A device route like a plugin's, checked by the same branch of the guard and
 * answering with the same headers, but served by the core and so by no plugin:
 * its tokens are the rows with no plugin, and a token for it opens no plugin's
 * route, nor a plugin's token this one. Always current, because the display
 * mode cannot be switched off apart from its tokens.
 */
export const DISPLAY_ROUTE: DeviceRoute = {
  pluginId: null,
  routeId: DISPLAY_ROUTE_ID,
  path: "/api/display",
};

/** The absolute path a plugin's device route is mounted on. */
export function deviceRoutePath(pluginId: string, path: string): string {
  return `/api/plugin/${pluginId}/${path}`;
}

/** Every device route the given manifests declare. */
export function resolveDeviceRoutes(
  manifests: Iterable<Pick<PluginManifest, "id" | "deviceRoutes">>,
): DeviceRoute[] {
  const routes: DeviceRoute[] = [];
  for (const manifest of manifests) {
    for (const route of manifest.deviceRoutes) {
      routes.push({
        pluginId: manifest.id,
        routeId: route.id,
        path: deviceRoutePath(manifest.id, route.path),
      });
    }
  }
  return routes;
}

/**
 * The device route a path is, or lies below, or null, compared segment by
 * segment.
 *
 * Sub-paths count, as they do for the protected resource: a path below a device
 * route that fell through to the cookie path would be an ordinary route
 * reachable with a board member's browser, which a device route must not be.
 * Routes never overlap within a plugin (the manifest refuses it) and live under
 * different mounts across plugins, so at most one matches.
 */
export function deviceRouteOf(
  routes: readonly DeviceRoute[],
  path: string,
): DeviceRoute | null {
  return deviceRouteAt(routes, segments(path));
}

function deviceRouteAt(
  routes: readonly DeviceRoute[],
  given: readonly string[],
): DeviceRoute | null {
  return (
    routes.find((route) => {
      const wanted = segments(route.path);
      return (
        given.length >= wanted.length &&
        wanted.every((segment, index) => given[index] === segment)
      );
    }) ?? null
  );
}

/**
 * The device route a request reaches, read as the router reads it.
 *
 * The router splits the path into segments at each `/` it was sent, and only
 * then decodes the escapes within a segment: `screen%2Fcontent` is one segment
 * whose value is `screen/content`, which a `:id` route takes whole. So the path
 * is compared segment by segment, each one decoded on its own, and an escaped
 * `/` never makes two segments of one.
 *
 * Where the router matched a route, that route has the last word. The request
 * is a device route's when the matched pattern lies under one, or when it
 * could reach the device route the path names as the seal reads patterns.
 * Otherwise the handler that runs is one the seal never held to a device
 * route, and the request is an ordinary one: a device token must not open a
 * handler that answers to a person's session.
 */
export function deviceRouteOfRequest(
  routes: readonly DeviceRoute[],
  request: { url: string; routeOptions?: { url?: string } },
): DeviceRoute | null {
  if (routes.length === 0) {
    return null;
  }
  const query = request.url.indexOf("?");
  const raw = query === -1 ? request.url : request.url.slice(0, query);
  const byPath = deviceRouteAt(routes, segments(raw).map(decodedSegment));
  const matched = request.routeOptions?.url;
  if (matched === undefined) {
    // No handler runs; the answer is a 404 or a preflight.
    return byPath;
  }
  return (
    deviceRouteOf(routes, matched) ??
    (byPath !== null && patternReaches(matched, byPath.path) ? byPath : null)
  );
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is refused by the router before any guard runs.
    return segment;
  }
}

/**
 * Whether a route the router mounts on `pattern` could answer a request for
 * the device route `base` or a path below it.
 *
 * Read segment by segment: a parameter segment (`:id`) stands for any one
 * segment and a wildcard (`*`) for any rest of the path, so `/api/plugin/x/:id`
 * reaches `/api/plugin/x/screen`. Conservative where a segment is anything but
 * plain text, because the failure in that direction is a plugin refused at load
 * for a route it could have kept, not a write reachable with a device token.
 */
export function patternReaches(pattern: string, base: string): boolean {
  const wanted = segments(base);
  const given = segments(pattern);
  for (const [index, segment] of given.entries()) {
    if (segment.includes("*")) {
      return true;
    }
    const target = wanted[index];
    if (target === undefined) {
      // The pattern goes on below the device route.
      return true;
    }
    if (!segment.includes(":") && segment !== target) {
      return false;
    }
  }
  return given.length >= wanted.length;
}

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/**
 * The device routes, in the two senses the host reads them.
 *
 * `current` are the routes the plugins that loaded declare now: the seal held
 * each of them to `GET` and `HEAD`, and they are the only paths a device token
 * opens. `asked` are those and every path a device may still be asking: the
 * routes the board consented to, among them one a version that is serving now
 * dropped, and those of a plugin that is not running. Every answer on one of
 * them carries the headers a device on another origin needs to read it, and a
 * path that is no longer a current route never takes a device token: whatever
 * the plugin now mounts there is an ordinary route, which the seal did not
 * hold to the device route rules.
 */
export interface DeviceRouteTable {
  current: readonly DeviceRoute[];
  asked: readonly DeviceRoute[];
}

/**
 * A holder, for the reason the protected resource has one: the routes are read
 * from what boot loaded, before there is a container to put them in.
 * `bootstrap.ts` sets it beside `setProtectedResource`.
 */
let table: DeviceRouteTable = { current: [], asked: [] };

export function setDeviceRoutes(routes: DeviceRouteTable): void {
  table = routes;
}

/** The device routes that take a device token: the core's and the plugins'. */
export function deviceRoutes(): readonly DeviceRoute[] {
  return [DISPLAY_ROUTE, ...table.current];
}

/** The paths that answer with the device route headers. */
export function askedDeviceRoutes(): readonly DeviceRoute[] {
  return [DISPLAY_ROUTE, ...table.asked];
}

/**
 * The path a device may still be asking that a request reaches, when no
 * device route that takes a token covers it: a route a consent or the version
 * serving dropped or moved, or one of a plugin that is not running. Null on a
 * current device route and on every other path.
 */
export function retiredDeviceRouteOfRequest(request: {
  url: string;
  routeOptions?: { url?: string };
}): DeviceRoute | null {
  if (deviceRouteOfRequest(deviceRoutes(), request) !== null) {
    return null;
  }
  // The same reading of the request for every route, so what matches here is
  // one of the paths that are not current.
  return deviceRouteOfRequest(table.asked, request);
}

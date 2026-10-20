import type { PluginManifest } from "@openbrf/plugin-sdk";

/**
 * Which paths on this instance are device routes (ADR 0031).
 *
 * A device route is a path under a plugin's own mount that answers to a device
 * token and to nothing else. Three things have to agree on which paths those
 * are: the authorization guard, which takes the device branch for them before
 * the cookie path; the response hooks, which send the CORS headers on them and
 * nowhere else; and the seal, which refuses a plugin that answers anything but
 * GET and HEAD under one. This file is the one place that decides it.
 */

/** One device route, with the absolute path it is mounted on. */
export interface DeviceRoute {
  pluginId: string;
  /** The route's id in the manifest, which a token is issued for. */
  routeId: string;
  /** Absolute, with no trailing slash: `/api/plugin/<id>/<path>`. */
  path: string;
}

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
 * The device route a path is, or lies below, or null.
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
  return (
    routes.find(
      (route) => path === route.path || path.startsWith(`${route.path}/`),
    ) ?? null
  );
}

/**
 * The device route a request reaches, read as the router reads it.
 *
 * The router matches the path after decoding its percent-escapes, so the raw
 * URL is not what decides which handler runs. The decoded path is compared,
 * and so is the route the router matched when there is one, so either
 * spelling of a device route is a device route. Decoding more than the router
 * does only widens the match, which is the conservative direction.
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
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape is refused by the router before any guard runs.
  }
  const matched = request.routeOptions?.url;
  return (
    deviceRouteOf(routes, decoded) ??
    (matched === undefined ? null : deviceRouteOf(routes, matched))
  );
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
 * A holder, for the reason the protected resource has one: the routes are read
 * from what boot loaded, before there is a container to put them in.
 * `bootstrap.ts` sets it beside `setProtectedResource`.
 */
let current: readonly DeviceRoute[] = [];

export function setDeviceRoutes(routes: readonly DeviceRoute[]): void {
  current = routes;
}

export function deviceRoutes(): readonly DeviceRoute[] {
  return current;
}

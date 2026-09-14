import type { Env } from "../config/env";
import type { BootPlugin, PluginFinding } from "../plugins/plugin-boot";

/**
 * Where connected apps sign in, and what every issued token is bound to.
 *
 * Core mounts no MCP route of its own. What an external client talks to is a
 * connector plugin's own route, declared in its manifest as
 * `oauthProtectedResource` and mounted under `/api/plugin/<id>/` like any other
 * plugin route. This file is the one place that decides which route that is,
 * because three separate injectors have to agree on the answer: the
 * authorization guard, which turns that path Bearer-only; the auth options,
 * which bind every token's audience to it; and the discovery controller, which
 * publishes it.
 */

/**
 * The plugin id a connector is expected to take, and the resource advertised
 * when none is installed.
 *
 * An instance with no connector still answers discovery and still issues
 * tokens, so sign-in is configurable and testable before a connector exists.
 * Nothing is mounted there: `declared` is false and the guard's Bearer branch
 * is not installed at all. A default that armed the guard would be worse than
 * useless, because the moment any plugin took this id and served `mcp` a real
 * route would silently become Bearer-only.
 */
export const DEFAULT_RESOURCE_PLUGIN_ID = "mcp-connector";
export const DEFAULT_RESOURCE_PATH = "/api/plugin/mcp-connector/mcp";

export interface ProtectedResource {
  /**
   * Whether a plugin actually serves this path.
   *
   * False means the path is the default above and nothing is mounted on it.
   * The guard reads this before its Bearer branch: an undeclared resource must
   * never convert a path that some unrelated plugin happens to serve.
   */
  declared: boolean;
  /** Absolute path on this instance, with no trailing slash. */
  path: string;
  /** Its full URL, which is the audience of every token issued. */
  url: string;
}

export interface ResolvedProtectedResource {
  resource: ProtectedResource;
  /**
   * One `oauth-resource-conflict` per plugin that declared a resource and did
   * not win it. Returned rather than pushed onto the boot object, so that this
   * function stays a pure decision the spec can drive directly.
   */
  findings: PluginFinding[];
}

/** The mount a plugin's routes are sealed onto. */
function pluginMount(id: string): string {
  return `/api/plugin/${id}`;
}

/**
 * Whether a request path is the resource or something beneath it.
 *
 * Sub-paths count. The connector serves a whole endpoint rather than a single
 * route, and a sub-path that fell through to the cookie path would be an
 * ordinary session-authenticated route reachable with the browser's own
 * cookie: the seal forces every plugin controller to be non-public and merges
 * the capability floor, so it would answer, which is exactly what this route
 * must not do. Matching the base and its children is the conservative
 * direction - the failure is a 401 on a path that could have been allowed,
 * not a session cookie accepted where only a token should be.
 */
export function isResourcePath(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Decides the resource from what this process actually loaded.
 *
 * Reads the loaded plugins rather than the database rows: a plugin that is
 * installed but refused, disabled or missing from the volume serves nothing,
 * and pointing the audience at a route nobody answers would leave every client
 * with a token for an address that 404s.
 */
export function resolveProtectedResource(
  plugins: readonly BootPlugin[],
  env: Env,
): ResolvedProtectedResource {
  // Narrowed as it is filtered rather than after, so the declared route is a
  // required value from here on: a fallback for an absent one would be
  // unreachable code able to produce a path this type says it never carries.
  const declaring = plugins
    .flatMap((plugin) => {
      const route = plugin.manifest.oauthProtectedResource;
      return route === undefined ? [] : [{ plugin, route }];
    })
    .toSorted((left, right) => {
      const byAge =
        left.plugin.installedAt.getTime() - right.plugin.installedAt.getTime();
      // Ties are broken by id so that two plugins installed in the same
      // millisecond - a seeded instance, a restored backup - resolve the same
      // way on every boot. A resource that moved between restarts would
      // invalidate tokens without anything having changed.
      //
      // By code unit, and not localeCompare, which reads the process default
      // locale: under LANG=da_DK the ids aa-connector and ab-connector order
      // the other way round, because Danish collates "aa" after "z". A
      // collation can also call two different ids equal, which hands the
      // winner back to the scan order this sort exists to take it away from.
      // The audience every live token carries must not depend on an
      // operator's locale.
      if (byAge !== 0) return byAge;
      if (left.plugin.id === right.plugin.id) return 0;
      return left.plugin.id < right.plugin.id ? -1 : 1;
    });

  const [incumbent, ...rest] = declaring;

  if (incumbent === undefined) {
    return {
      resource: {
        declared: false,
        path: DEFAULT_RESOURCE_PATH,
        url: resourceUrl(DEFAULT_RESOURCE_PATH, env),
      },
      findings: [],
    };
  }

  const path = `${pluginMount(incumbent.plugin.id)}/${incumbent.route}`;

  return {
    resource: { declared: true, path, url: resourceUrl(path, env) },
    // The incumbent keeps it and the newcomers are told why. Falling back to
    // the default instead would move the audience, so every live token's
    // `resources` would stop matching and the connector's own route would stop
    // accepting Bearer because an unrelated plugin was installed.
    findings: rest.map(({ plugin }) => ({
      id: plugin.id,
      directory: plugin.directory,
      reason: "oauth-resource-conflict" as const,
      detail: { incumbent: incumbent.plugin.id, path },
    })),
  };
}

function resourceUrl(path: string, env: Env): string {
  return new URL(path, env.APP_URL).toString();
}

/**
 * A holder, for the reason the plugin boot object is one: the resource is
 * decided from what boot loaded, which happens before there is a container to
 * put it in. `bootstrap.ts` sets it beside `setPluginBoot`, and a global
 * module provides it to the three injectors that read it.
 */
let current: ProtectedResource = {
  declared: false,
  path: DEFAULT_RESOURCE_PATH,
  url: `http://localhost:5173${DEFAULT_RESOURCE_PATH}`,
};

export function setProtectedResource(resource: ProtectedResource): void {
  current = resource;
}

export function protectedResource(): ProtectedResource {
  return current;
}

import { All, Body, Controller, Logger, Param, Req } from "@nestjs/common";
import type { PluginRequest } from "@openbrf/plugin-sdk";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import {
  type Capability,
  CAPABILITIES,
  principalCan,
} from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  normalizeRoutePath,
  PluginLoaderService,
} from "./plugin-loader.service";
import {
  PluginHandlerError,
  PluginNotFoundError,
  PluginRouteNotFoundError,
} from "./plugin.errors";
import { PluginForbiddenError } from "./plugin-forbidden.error";

/**
 * Serves the routes plugins contribute.
 *
 * One dispatcher rather than each plugin registering its own controller, and
 * that is the security design rather than a convenience. Everything a plugin
 * route reaches - the session, the principal, the capability check, the
 * exception filter - is the application's own, so a plugin endpoint can never
 * be the one endpoint on the instance that forgot to check a session. It also
 * means a plugin needs nothing from @nestjs/* to serve HTTP, which is what
 * keeps a plugin bundle self-contained (ADR 0003).
 *
 * Mounted at /api/plugin/<id>/ - singular, so it cannot collide with the
 * /api/plugins administration routes.
 */
@Controller("api/plugin/:pluginId")
@RequireCapability("self:manage")
export class PluginRouteController {
  private readonly logger = new Logger(PluginRouteController.name);

  constructor(private readonly loader: PluginLoaderService) {}

  /*
   * A bare wildcard, not a named one. The application runs on Fastify, whose
   * router requires the wildcard to be the last character of the path and
   * rejects the named form outright at start-up. The matched remainder comes
   * back as the "*" parameter.
   */
  @All("*")
  async dispatch(
    @Param("pluginId") pluginId: string,
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<unknown> {
    const plugin = this.loader.get(pluginId);
    if (plugin === null) {
      // A disabled or unloaded plugin is indistinguishable from one that was
      // never installed, on purpose: which plugins an instance has is not
      // something an arbitrary signed-in account needs to be able to probe.
      throw new PluginNotFoundError(pluginId);
    }

    const method = request.method.toUpperCase();
    const routePath = normalizeRoutePath(wildcardPath(request));
    const entry = plugin.routes.get(`${method} ${routePath}`);
    if (entry === undefined) {
      throw new PluginRouteNotFoundError(pluginId, routePath);
    }

    const principal = request.principal;
    if (principal === undefined) {
      throw new Error("The authorization guard did not attach a principal.");
    }

    // The capability the loader settled on, which is the route's own raised to
    // the floor its plugin's permissions imply. An unrecognised capability
    // name refuses the request rather than being ignored: a plugin naming a
    // capability this host does not have has asked for something, and treating
    // that as "no requirement" would grant it.
    if (!isCapability(entry.capability)) {
      throw new PluginForbiddenError(pluginId);
    }
    if (!principalCan(principal, entry.capability)) {
      throw new PluginForbiddenError(pluginId);
    }

    const pluginRequest: PluginRequest = {
      query: toStringRecord(request.query),
      body: body ?? null,
      personId: principal.personId,
    };

    try {
      return await entry.route.handle(pluginRequest);
    } catch (cause) {
      // The plugin's own failure, logged with its id so an operator can see
      // whose bug it is, and answered as a bad gateway rather than as a fault
      // in the platform.
      this.logger.error(
        `Plugin "${pluginId}" failed handling ${method} ${routePath}.`,
        cause,
      );
      throw new PluginHandlerError(pluginId);
    }
  }
}

function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** The part of the path the wildcard matched. */
function wildcardPath(request: { params?: unknown }): string {
  const params = request.params;
  if (typeof params !== "object" || params === null) {
    return "";
  }
  const matched = (params as Record<string, unknown>)["*"];
  return typeof matched === "string" ? matched : "";
}

/**
 * Query strings reach a plugin as strings.
 *
 * Fastify parses repeated keys into arrays; a plugin's contract says string,
 * so the last value wins - the same rule a form submission follows.
 */
function toStringRecord(query: unknown): Record<string, string> {
  if (typeof query !== "object" || query === null) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      const last = value.at(-1);
      if (typeof last === "string") {
        result[key] = last;
      }
    }
  }
  return result;
}

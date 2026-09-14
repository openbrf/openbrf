import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { Env } from "../config/env";
import type { BootPlugin } from "../plugins/plugin-boot";
import {
  DEFAULT_RESOURCE_PATH,
  DEFAULT_RESOURCE_PLUGIN_ID,
  isResourcePath,
  protectedResource,
  resolveProtectedResource,
  setProtectedResource,
} from "./protected-resource";

/**
 * Which route connected apps sign in to, decided once from what boot loaded.
 *
 * Three injectors have to reach the same answer - the guard that turns the
 * path Bearer-only, the auth options that bind every token's audience to it,
 * and the discovery document that publishes it - and they have to reach the
 * same answer on every restart. The audience is a single URL carried by every
 * token already issued, so a resource that moved between boots would
 * invalidate them all with nothing having changed. That makes the two
 * uninteresting-looking properties here the load-bearing ones: that an
 * instance with no connector says so rather than pointing somewhere, and that
 * the winner among several is decided by something neither the scan order nor
 * the volume can vary.
 */

/**
 * The holder as it stands before anything sets it, read at module load so no
 * test can have moved it first.
 */
const INITIAL_RESOURCE = protectedResource();

/** Only APP_URL is read, and only to resolve the path against it. */
const ENV = { APP_URL: "https://brf.example.se" } as Env;

const PLUGINS_ROOT = "/data/plugins/node_modules";

interface Installed {
  id: string;
  installedAt: string;
  /** The manifest's `oauthProtectedResource`; absent when it declares none. */
  declares?: string;
}

function plugin({ id, installedAt, declares }: Installed): BootPlugin {
  return {
    id,
    version: "1.0.0",
    manifest: { oauthProtectedResource: declares } as BootPlugin["manifest"],
    directory: `${PLUGINS_ROOT}/openbrf-plugin-${id}`,
    module: null,
    context: {} as BootPlugin["context"],
    host: {} as BootPlugin["host"],
    controllers: [],
    locales: {},
    installedAt: new Date(installedAt),
  };
}

describe("the default resource", () => {
  it("sits under the mount of the id a connector is expected to take", () => {
    // The two constants are advertised separately - the path in discovery, the
    // id on the install screen - and a default path under some other mount
    // would name a route the expected connector could never serve.
    expect(DEFAULT_RESOURCE_PATH).toBe(
      `/api/plugin/${DEFAULT_RESOURCE_PLUGIN_ID}/mcp`,
    );
  });
});

describe("resolveProtectedResource", () => {
  it("advertises the default path, undeclared, when nothing serves one", () => {
    const { resource, findings } = resolveProtectedResource(
      [plugin({ id: "occupancy", installedAt: "2026-01-02T00:00:00Z" })],
      ENV,
    );

    // `declared` is what the guard reads before it installs its Bearer branch,
    // and the whole reason the flag exists rather than a comparison against the
    // default path. False means nothing is mounted there: were it true on a
    // bare instance, the day any plugin took that id and served that route the
    // route would silently stop accepting the browser's session.
    expect(resource.declared).toBe(false);
    expect(resource.path).toBe(DEFAULT_RESOURCE_PATH);
    expect(resource.url).toBe(`https://brf.example.se${DEFAULT_RESOURCE_PATH}`);
    // An instance still answers discovery and still issues tokens with no
    // connector installed, so a plugin that declares nothing is not a conflict.
    expect(findings).toEqual([]);
  });

  it("takes the path from the one plugin that declares one", () => {
    const { resource, findings } = resolveProtectedResource(
      [
        plugin({ id: "notices", installedAt: "2026-01-02T00:00:00Z" }),
        plugin({
          id: "connector",
          installedAt: "2026-01-03T00:00:00Z",
          declares: "mcp",
        }),
      ],
      ENV,
    );

    expect(resource.declared).toBe(true);
    expect(resource.path).toBe("/api/plugin/connector/mcp");
    expect(resource.url).toBe(
      "https://brf.example.se/api/plugin/connector/mcp",
    );
    // `notices` is the older install and would win on seniority alone. It
    // declares nothing, so it is neither the winner nor a loser: it is not
    // competing for the resource at all.
    expect(findings).toEqual([]);
  });

  it("joins a multi-segment declaration with a single slash", () => {
    const { resource } = resolveProtectedResource(
      [
        plugin({
          id: "connector",
          installedAt: "2026-01-01T00:00:00Z",
          declares: "mcp/v1",
        }),
      ],
      ENV,
    );

    // The manifest writes the route with no leading slash and the mount carries
    // no trailing one, so the join is the only place the separator comes from.
    // A path with an empty segment is a different path, and the guard matches
    // on equality and a prefix: it would stop recognising its own resource.
    expect(resource.path).toBe("/api/plugin/connector/mcp/v1");
    expect(resource.path).not.toContain("//");
    expect(new URL(resource.url).pathname).toBe("/api/plugin/connector/mcp/v1");
  });

  it("gives the resource to the older install and reports the newer one", () => {
    const newer = plugin({
      id: "aaa-connector",
      installedAt: "2026-03-01T00:00:00Z",
      declares: "mcp",
    });
    const older = plugin({
      id: "zzz-connector",
      installedAt: "2026-01-01T00:00:00Z",
      declares: "mcp",
    });

    // Newest first in the array, and the ids sort against the install dates
    // too, so an implementation that returned the first element or the lowest
    // id would both be visible here rather than passing by coincidence.
    const { resource, findings } = resolveProtectedResource(
      [newer, older],
      ENV,
    );

    expect(resource.declared).toBe(true);
    expect(resource.path).toBe("/api/plugin/zzz-connector/mcp");
    // The newcomer is told why it lost, by code and with its own directory:
    // the admin screen renders the sentence and the operator has to be able to
    // find the package on the volume.
    expect(findings).toEqual([
      {
        id: "aaa-connector",
        directory: `${PLUGINS_ROOT}/openbrf-plugin-aaa-connector`,
        reason: "oauth-resource-conflict",
        detail: {
          incumbent: "zzz-connector",
          path: "/api/plugin/zzz-connector/mcp",
        },
      },
    ]);
  });

  it("reports every plugin that lost the resource, once each", () => {
    const { resource, findings } = resolveProtectedResource(
      [
        plugin({
          id: "third",
          installedAt: "2026-03-01T00:00:00Z",
          declares: "mcp",
        }),
        plugin({
          id: "first",
          installedAt: "2026-01-01T00:00:00Z",
          declares: "mcp",
        }),
        plugin({ id: "quiet", installedAt: "2025-01-01T00:00:00Z" }),
        plugin({
          id: "second",
          installedAt: "2026-02-01T00:00:00Z",
          declares: "mcp",
        }),
      ],
      ENV,
    );

    expect(resource.path).toBe("/api/plugin/first/mcp");
    // One finding per loser and nothing else. `quiet` is the oldest install on
    // the volume and declares nothing, so it neither wins nor is reported.
    expect(findings.map((finding) => finding.id)).toEqual(["second", "third"]);
    expect(findings.map((finding) => finding.reason)).toEqual([
      "oauth-resource-conflict",
      "oauth-resource-conflict",
    ]);
  });

  it("breaks a tie on the id, whichever order the plugins arrive in", () => {
    const moment = "2026-01-01T00:00:00Z";
    const alpha = plugin({
      id: "alpha-connector",
      installedAt: moment,
      declares: "mcp",
    });
    const omega = plugin({
      id: "omega-connector",
      installedAt: moment,
      declares: "mcp",
    });

    const oneWay = resolveProtectedResource([alpha, omega], ENV);
    const other = resolveProtectedResource([omega, alpha], ENV);

    // A seeded instance and a restored backup both write their rows in one
    // transaction, so the timestamps tie and the only thing left to decide on
    // is the order the volume happened to be scanned in. That is not stable
    // across restarts, and the audience is the URL every live token carries: a
    // winner that moved would invalidate them all with nothing having changed.
    expect(oneWay.resource.path).toBe("/api/plugin/alpha-connector/mcp");
    expect(other.resource).toEqual(oneWay.resource);
    expect(other.findings).toEqual(oneWay.findings);
    expect(other.findings.map((finding) => finding.id)).toEqual([
      "omega-connector",
    ]);
  });

  it("breaks a tie the same way whatever locale the process runs under", () => {
    /*
     * The pair a collation actually disagrees about. Danish sorts "aa" as "å",
     * after "z", so localeCompare orders these two the other way round the
     * moment LANG=da_DK is set on the container - and the winner is the
     * audience every issued token is bound to, so an operator's locale would
     * silently disconnect every connected app in the association. Both ids are
     * valid under the manifest's own id pattern.
     *
     * The spy is what makes this a regression test rather than a statement
     * about the machine it runs on. Under the en-US the suite runs with,
     * localeCompare agrees with code-unit order for this pair, so the two
     * value assertions below would pass just as well after a revert. What must
     * not come back is the call: this decision consults no collation at all,
     * and only a test that says so fails outside a Danish locale.
     */
    const localeCompare = vi.spyOn(String.prototype, "localeCompare");
    onTestFinished(() => localeCompare.mockRestore());

    const moment = "2026-01-01T00:00:00Z";
    const plugins = [
      plugin({ id: "ab-connector", installedAt: moment, declares: "mcp" }),
      plugin({ id: "aa-connector", installedAt: moment, declares: "mcp" }),
    ];

    const { resource, findings } = resolveProtectedResource(plugins, ENV);

    expect(resource.path).toBe("/api/plugin/aa-connector/mcp");
    expect(findings.map((finding) => finding.id)).toEqual(["ab-connector"]);
    expect(localeCompare).not.toHaveBeenCalled();
  });
});

describe("isResourcePath", () => {
  const BASE = "/api/plugin/connector/mcp";

  it("matches the resource itself", () => {
    expect(isResourcePath(BASE, BASE)).toBe(true);
  });

  it("matches a path beneath the resource", () => {
    // The connector serves a whole endpoint rather than one route. A sub-path
    // that fell through to the cookie branch would be an ordinary
    // session-authenticated route - the seal makes every plugin controller
    // non-public and merges the capability floor, so it would answer - and it
    // would answer to the browser's own cookie.
    expect(isResourcePath(`${BASE}/messages`, BASE)).toBe(true);
  });

  it("does not match a sibling whose name merely begins with the same characters", () => {
    // What a bare startsWith gets wrong, and the reason this is a function
    // rather than a comparison written out at each of its call sites: a
    // neighbouring route of the same plugin would stop accepting the session
    // cookie and start demanding a token issued for an address it is not at.
    expect(isResourcePath(`${BASE}x`, BASE)).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(isResourcePath("/api/auth/session", BASE)).toBe(false);
  });
});

describe("the protected resource holder", () => {
  it("starts as the undeclared default", () => {
    // The value the three injectors would read if bootstrap had not run. It
    // has to be the undeclared default for the same reason a bare instance
    // resolves to one: nothing may be Bearer-only on the strength of a resource
    // nobody has decided yet. The origin is the development default of APP_URL.
    expect(INITIAL_RESOURCE).toEqual({
      declared: false,
      path: DEFAULT_RESOURCE_PATH,
      url: `http://localhost:5173${DEFAULT_RESOURCE_PATH}`,
    });
  });

  it("returns what was last set", () => {
    const { resource } = resolveProtectedResource(
      [
        plugin({
          id: "connector",
          installedAt: "2026-01-01T00:00:00Z",
          declares: "mcp",
        }),
      ],
      ENV,
    );

    setProtectedResource(resource);

    // Read through a provider factory after bootstrap has set it, so what the
    // injectors get is the record boot decided on and not a value captured
    // when the module was imported.
    expect(protectedResource()).toBe(resource);
  });
});

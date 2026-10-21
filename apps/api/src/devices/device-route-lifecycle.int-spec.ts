import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import type { ProtectedResource } from "../auth/protected-resource";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { dataPaths } from "../packaging/data-paths";
import { PluginLoaderService } from "../plugins/plugin-loader.service";
import { PluginRegistryService } from "../plugins/plugin-registry.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { DEVICE_TOKEN_PREFIX, mintDeviceToken } from "./device-token";

/**
 * A device route of a plugin that is not running, across a restart (ADR 0031).
 *
 * A device asks the same route for years, and keeps asking while its plugin is
 * paused or after it is gone. Every answer it gets has to carry the headers a
 * page on another origin needs to read it: a 404 it cannot read looks like a
 * failure to connect, and the device goes on showing what it had. Each case
 * boots the application again, the way an instance comes back after the
 * change, because what a restart forgets is what is under test.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
const PLUGIN = `devices-lifecycle-${suffix}`;
/** A plugin whose version is republished without one of its device routes. */
const DROPPING = `devices-dropping-${suffix}`;
/** A plugin the board consents to again, each time with other routes. */
const CONSENTING = `devices-consenting-${suffix}`;
/** A plugin whose version declares a dropped route's path its resource. */
const RESOURCING = `devices-resourcing-${suffix}`;
const PLUGINS = [PLUGIN, DROPPING, CONSENTING, RESOURCING];
const PASSWORD = "integration-password-1";
const ORIGIN = "app://tv.example";

/** The connected app the access token below is issued to. */
const CONNECTED_APP = `https://klient-${suffix}.exempel.se/id`;
const SCOPES = ["mcp:read", "mcp:write"];

const board = {
  personId: `devices-lifecycle-board-${suffix}`,
  email: `devices-lifecycle-board-${suffix}@exempel.se`,
};

/** Every handler the plugin's controller has, by path. */
const ALL_HANDLERS: readonly (readonly [string, string])[] = [
  ["screen/content", "content"],
  ["menu/today", "menu"],
  ["admin/tokens", "tokens"],
];

/** The plugin's server entry, mounting the given handlers and no others. */
function bundle(handlers: readonly (readonly [string, string])[]): string {
  return `const { Controller, Get, Module } = require("@nestjs/common");

exports.createPlugin = function createPlugin() {
  class Screens {
    content() {
      return { ok: true };
    }
    menu() {
      return { ok: true };
    }
    tokens() {
      return { tokens: [] };
    }
  }
  Controller()(Screens);
  for (const [path, name] of ${JSON.stringify(handlers)}) {
    Get(path)(Screens.prototype, name, Object.getOwnPropertyDescriptor(Screens.prototype, name));
  }
  class LifecyclePluginModule {}
  Module({ controllers: [Screens] })(LifecyclePluginModule);
  return { module: LifecyclePluginModule };
};
`;
}

let workspace = "";
let previousDataDir: string | undefined;
let previousEnabled: string | undefined;

function packageDirectory(id = PLUGIN): string {
  return join(
    dataPaths(workspace).plugins,
    "node_modules",
    `openbrf-plugin-${id}`,
  );
}

/** The server entry every package starts with. */
const SERVER_ENTRY = "server.cjs";

/**
 * Writes a server entry for the package, mounting the given handlers. Another
 * build goes in a file of its own: Node keeps a module it has loaded, and the
 * next boot in this process would load the first one again.
 */
async function writeBundle(
  handlers: readonly (readonly [string, string])[],
  id = PLUGIN,
  file = SERVER_ENTRY,
): Promise<void> {
  await writeFile(
    join(packageDirectory(id), "dist", file),
    bundle(handlers),
    "utf8",
  );
}

/**
 * Writes the package's manifest, declaring the given device routes and, when
 * named, the path it serves connected apps on.
 */
async function writeManifest(
  deviceRoutes: { id: string; path: string }[],
  id = PLUGIN,
  server = SERVER_ENTRY,
  oauthProtectedResource?: string,
): Promise<void> {
  await writeFile(
    join(packageDirectory(id), "package.json"),
    JSON.stringify({
      name: `openbrf-plugin-${id}`,
      version: "1.0.0",
      openbrf: {
        apiVersion: 1,
        id,
        entry: { server: `./dist/${server}` },
        permissions: [],
        personalData: [],
        deviceRoutes,
        oauthProtectedResource,
      },
    }),
    "utf8",
  );
}

function env(pluginsEnabled: boolean): Env {
  return {
    ...baseEnv,
    OPENBRF_DATA_DIR: workspace,
    OPENBRF_PLUGINS_ENABLED: pluginsEnabled,
  };
}

/** Starts the application as a restart would, with plugins on or off. */
async function boot(pluginsEnabled: boolean): Promise<NestFastifyApplication> {
  process.env.OPENBRF_PLUGINS_ENABLED = String(pluginsEnabled);
  const app = await createApplication(
    await loadPluginsAtBoot(env(pluginsEnabled)),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function inject(
  app: NestFastifyApplication,
  options: {
    method: "GET" | "OPTIONS" | "DELETE";
    url: string;
    headers?: Record<string, string>;
  },
) {
  return app.getHttpAdapter().getInstance().inject(options);
}

/** What a web player sends: its token, from a page on another origin. */
const DEVICE_HEADERS = {
  origin: ORIGIN,
  authorization: `Bearer ${DEVICE_TOKEN_PREFIX}${"a".repeat(43)}`,
};

async function expectReadable404(app: NestFastifyApplication): Promise<void> {
  const response = await inject(app, {
    method: "GET",
    url: `/api/plugin/${PLUGIN}/screen/content`,
    headers: DEVICE_HEADERS,
  });
  expect(response.statusCode).toBe(404);
  expect(response.headers["access-control-allow-origin"]).toBe("*");
  expect(response.headers["access-control-expose-headers"]).toBe(
    "ETag, Retry-After, WWW-Authenticate",
  );
  expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  expect(response.headers["cache-control"]).toBe("no-store");

  // The browser asks before it sends the token, and has to be told yes.
  const preflight = await inject(app, {
    method: "OPTIONS",
    url: `/api/plugin/${PLUGIN}/screen/content`,
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-headers"]).toBe(
    "Authorization, If-None-Match",
  );

  // And still on the device route only.
  const other = await inject(app, {
    method: "GET",
    url: `/api/plugin/${PLUGIN}/admin/tokens`,
    headers: { origin: ORIGIN },
  });
  expect(other.headers["access-control-allow-origin"]).toBeUndefined();
}

/**
 * What a device asking a path whose route is gone must read: the 401 that
 * says its token is gone, with the headers that let a page on another origin
 * read it, and a preflight that lets it ask.
 */
async function expectReadableRefusal(
  app: NestFastifyApplication,
  id: string,
  path: string,
  token = DEVICE_HEADERS.authorization.slice("Bearer ".length),
): Promise<void> {
  const url = `/api/plugin/${id}/${path}`;
  const response = await inject(app, {
    method: "GET",
    url,
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(401);
  expect(response.headers["www-authenticate"]).toBe('Bearer realm="device"');
  expect(response.headers["access-control-allow-origin"]).toBe("*");
  expect(response.headers["access-control-expose-headers"]).toBe(
    "ETag, Retry-After, WWW-Authenticate",
  );
  expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  expect(response.headers["cache-control"]).toBe("no-store");

  const preflight = await inject(app, {
    method: "OPTIONS",
    url,
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe("*");
  expect(preflight.headers["access-control-allow-headers"]).toBe(
    "Authorization, If-None-Match",
  );
}

const SCREEN = { id: "screen", path: "screen" };
const MENU = { id: "menu", path: "menu" };

/**
 * Records the board's consent to the given device routes, and leaves the row
 * as the reconcile leaves a plugin it has installed on the volume.
 */
async function consent(
  prisma: PrismaService,
  id: string,
  deviceRoutes: { id: string; path: string }[],
): Promise<void> {
  await new PluginRegistryService(prisma).consent({
    id,
    packageName: `openbrf-plugin-${id}`,
    version: "1.0.0",
    tarballUrl: `file:///dev/null/${id}.tgz`,
    checksum: "sha512-unused-in-this-suite",
    permissions: [],
    personalData: [],
    actions: [],
    deviceRoutes,
    ai: false,
  });
  await prisma.installedPlugin.update({
    where: { id },
    data: { status: "INSTALLED" },
  });
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openbrf-device-lifecycle-"));
  const prisma = new PrismaService(baseEnv);
  await prisma.$connect();
  try {
    for (const [id, deviceRoutes] of [
      [PLUGIN, [SCREEN]],
      [DROPPING, [SCREEN, MENU]],
      [CONSENTING, [SCREEN, MENU]],
      [RESOURCING, [SCREEN, MENU]],
    ] as const) {
      const directory = packageDirectory(id);
      await mkdir(join(directory, "dist"), { recursive: true });
      await writeManifest([...deviceRoutes], id);
      await writeBundle(ALL_HANDLERS, id);

      await prisma.installedPlugin.deleteMany({ where: { id } });
      await prisma.pluginDeviceRoutePath.deleteMany({
        where: { pluginId: id },
      });
      await consent(prisma, id, [...deviceRoutes]);
    }
    const existing = await prisma.association.findUnique({ where: { id: 1 } });
    if (existing === null) {
      await prisma.association.create({
        data: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
      });
    }
    await prisma.person.create({
      data: { id: board.personId, firstName: "Styrelse", lastName: suffix },
    });
    // The administrator removes plugins.
    await prisma.systemRole.create({
      data: { personId: board.personId, role: "ADMIN" },
    });
  } finally {
    await prisma.$disconnect();
  }

  previousDataDir = process.env.OPENBRF_DATA_DIR;
  previousEnabled = process.env.OPENBRF_PLUGINS_ENABLED;
  process.env.OPENBRF_DATA_DIR = workspace;
}, 60_000);

afterAll(async () => {
  try {
    const prisma = new PrismaService(baseEnv);
    await prisma.$connect();
    try {
      // Every consent and token written for the connected app goes with it.
      await prisma.oauthClient.deleteMany({
        where: { clientId: CONNECTED_APP },
      });
      await prisma.pluginDeviceToken.deleteMany({
        where: { pluginId: { in: PLUGINS } },
      });
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: PLUGINS } },
      });
      await prisma.pluginDeviceRoutePath.deleteMany({
        where: { pluginId: { in: PLUGINS } },
      });
      await prisma.systemRole.deleteMany({
        where: { personId: board.personId },
      });
      await prisma.user.deleteMany({ where: { personId: board.personId } });
      await prisma.person.deleteMany({ where: { id: board.personId } });
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
    restoreEnvironmentVariable("OPENBRF_PLUGINS_ENABLED", previousEnabled);
    await rm(workspace, { recursive: true, force: true });
  }
});

describe("a device route whose plugin is not running", () => {
  it("answers a 404 a device can read with plugins switched off for the instance", async () => {
    const app = await boot(false);
    try {
      await expectReadable404(app);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("answers a 404 a device can read while a version that moved it is refused", async () => {
    // The same version republished with the route moved, which the board has
    // not seen: refused at boot, while the devices go on asking `screen`.
    await writeManifest([{ id: "screen", path: "display" }]);
    try {
      const app = await boot(true);
      try {
        expect(
          app
            .get(PluginLoaderService)
            .report()
            .find((finding) => finding.id === PLUGIN),
        ).toMatchObject({ reason: "device-routes-widened" });
        await expectReadable404(app);
      } finally {
        await app.close();
      }
    } finally {
      await writeManifest([{ id: "screen", path: "screen" }]);
    }
  }, 60_000);

  it("answers a 404 a device can read after its plugin is removed and the instance restarts", async () => {
    const running = await boot(true);
    try {
      await running.get(AuthService).createAccountForPerson({
        personId: board.personId,
        email: board.email,
        name: "Styrelse",
        password: PASSWORD,
      });
      const session = await running
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          payload: { email: board.email, password: PASSWORD },
        });
      const setCookie = session.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
        .map((value) => value.split(";")[0])
        .join("; ");

      const removed = await inject(running, {
        method: "DELETE",
        url: `/api/plugins/${PLUGIN}`,
        headers: { cookie, origin: new URL(baseEnv.APP_URL).origin },
      });
      expect(removed.statusCode).toBe(200);
    } finally {
      await running.close();
    }
    // What the reconcile the removal queued does before the restart.
    await rm(packageDirectory(), { recursive: true, force: true });

    const restarted = await boot(true);
    try {
      await expectReadable404(restarted);
    } finally {
      await restarted.close();
    }
  }, 120_000);
});

/** A live token for one of a plugin's routes, as issuing leaves it. */
async function issueToken(
  prisma: PrismaService,
  route: string,
  pluginId = DROPPING,
): Promise<{ id: string; token: string }> {
  const token = mintDeviceToken();
  const row = await prisma.pluginDeviceToken.create({
    data: {
      pluginId,
      routeId: route,
      subject: `scr_${route}`,
      label: "Entrance B",
      tokenHash: hashOpaqueToken(token),
      issuedByPersonId: board.personId,
    },
  });
  return { id: row.id, token };
}

async function deviceCall(
  app: NestFastifyApplication,
  path: string,
  token: string,
): Promise<number> {
  const response = await inject(app, {
    method: "GET",
    url: `/api/plugin/${DROPPING}/${path}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return response.statusCode;
}

describe("a version republished without one of its device routes", () => {
  it("revokes that route's tokens when it starts serving, and they stay refused when the route returns", async () => {
    const prisma = new PrismaService(baseEnv);
    await prisma.$connect();
    try {
      const screen = await issueToken(prisma, "screen");
      const menu = await issueToken(prisma, "menu");
      const revokedAt = async (id: string) =>
        (await prisma.pluginDeviceToken.findUniqueOrThrow({ where: { id } }))
          .revokedAt;

      // The same version, republished without `menu`, and nobody asked again.
      await writeManifest([SCREEN], DROPPING);

      // Paused, not cut, while plugins are switched off for the instance.
      const off = await boot(false);
      await off.close();
      expect(await revokedAt(menu.id)).toBeNull();

      // And while the version is refused: here it also moves `screen`.
      await writeManifest([{ id: "screen", path: "display" }], DROPPING);
      const refused = await boot(true);
      try {
        expect(refused.get(PluginLoaderService).get(DROPPING)).toBeNull();
      } finally {
        await refused.close();
      }
      expect(await revokedAt(menu.id)).toBeNull();

      await writeManifest([SCREEN], DROPPING);
      const dropped = await boot(true);
      try {
        expect(dropped.get(PluginLoaderService).get(DROPPING)).not.toBeNull();
        expect(await revokedAt(menu.id)).not.toBeNull();
        expect(await revokedAt(screen.id)).toBeNull();
        expect(await deviceCall(dropped, "screen/content", screen.token)).toBe(
          200,
        );

        // The screen given `menu` goes on asking it, and must be able to read
        // that its token is gone, although the version serving mounts an
        // ordinary route there now.
        const gone = await inject(dropped, {
          method: "GET",
          url: `/api/plugin/${DROPPING}/menu/today`,
          headers: { origin: ORIGIN, authorization: `Bearer ${menu.token}` },
        });
        expect(gone.statusCode).toBe(401);
        expect(gone.headers["www-authenticate"]).toBe('Bearer realm="device"');
        expect(gone.headers["access-control-allow-origin"]).toBe("*");
        expect(gone.headers["access-control-expose-headers"]).toBe(
          "ETag, Retry-After, WWW-Authenticate",
        );
        expect(
          gone.headers["access-control-allow-credentials"],
        ).toBeUndefined();
        expect(gone.headers["cache-control"]).toBe("no-store");
        const preflight = await inject(dropped, {
          method: "OPTIONS",
          url: `/api/plugin/${DROPPING}/menu/today`,
          headers: {
            origin: ORIGIN,
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe("*");
        expect(preflight.headers["access-control-allow-headers"]).toBe(
          "Authorization, If-None-Match",
        );

        // A live token opens no route but its own, and a former one opens
        // nothing: the token for `screen` is refused on `menu` as well.
        expect(await deviceCall(dropped, "menu/today", screen.token)).toBe(401);
        expect(await deviceCall(dropped, "admin/tokens", screen.token)).toBe(
          401,
        );
        const other = await inject(dropped, {
          method: "GET",
          url: `/api/plugin/${DROPPING}/admin/tokens`,
          headers: { origin: ORIGIN },
        });
        expect(other.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await dropped.close();
      }

      // A later build of the version mounts nothing on `menu` at all. The
      // router matches no handler there, so no guard runs, and the device must
      // still read the 401 rather than a 404 that would make it keep its
      // token for good.
      const unmountedEntry = "server-without-menu.cjs";
      await writeBundle(
        ALL_HANDLERS.filter(([path]) => !path.startsWith("menu/")),
        DROPPING,
        unmountedEntry,
      );
      await writeManifest([SCREEN], DROPPING, unmountedEntry);
      try {
        const unmounted = await boot(true);
        try {
          expect(
            unmounted.get(PluginLoaderService).get(DROPPING),
          ).not.toBeNull();
          const server = unmounted.getHttpAdapter().getInstance();
          expect(
            server.hasRoute({
              method: "GET",
              url: `/api/plugin/${DROPPING}/menu/today`,
            }),
          ).toBe(false);
          expect(
            server.hasRoute({
              method: "GET",
              url: `/api/plugin/${DROPPING}/screen/content`,
            }),
          ).toBe(true);
          await expectReadableRefusal(
            unmounted,
            DROPPING,
            "menu/today",
            menu.token,
          );
          await expectReadableRefusal(
            unmounted,
            DROPPING,
            "menu/today",
            screen.token,
          );
          // Without a token it is a path nothing answers, readable as one.
          const missing = await inject(unmounted, {
            method: "GET",
            url: `/api/plugin/${DROPPING}/menu/today`,
            headers: { origin: ORIGIN },
          });
          expect(missing.statusCode).toBe(404);
          expect(missing.headers["access-control-allow-origin"]).toBe("*");
          expect(
            await deviceCall(unmounted, "screen/content", screen.token),
          ).toBe(200);
          // And nowhere else is a 404 turned into a device's 401.
          expect(await deviceCall(unmounted, "elsewhere", screen.token)).toBe(
            404,
          );
        } finally {
          await unmounted.close();
        }

        // A plugin that is not serving answers 404 there, before any token
        // is read, as on every one of its paths.
        const paused = await boot(false);
        try {
          const response = await inject(paused, {
            method: "GET",
            url: `/api/plugin/${DROPPING}/menu/today`,
            headers: { origin: ORIGIN, authorization: `Bearer ${menu.token}` },
          });
          expect(response.statusCode).toBe(404);
          expect(response.headers["access-control-allow-origin"]).toBe("*");
          expect(response.headers["www-authenticate"]).toBeUndefined();
        } finally {
          await paused.close();
        }
      } finally {
        await writeManifest([SCREEN], DROPPING);
      }

      const entries = await prisma.auditLogEntry.findMany({
        where: {
          action: "DEVICE_TOKEN_REVOKED",
          targetKind: "device-token",
          targetId: { in: [screen.id, menu.id] },
        },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetId: menu.id,
        channel: "SYSTEM",
        actorPersonId: null,
        context: {
          plugin: DROPPING,
          route: "menu",
          subject: "scr_menu",
          routeDropped: true,
        },
      });

      // The route comes back on a later restart, still within the consent.
      await writeManifest([SCREEN, MENU], DROPPING);
      const restored = await boot(true);
      try {
        expect(restored.get(PluginLoaderService).get(DROPPING)).not.toBeNull();
        expect(await deviceCall(restored, "menu/today", menu.token)).toBe(401);
        expect(await deviceCall(restored, "screen/content", screen.token)).toBe(
          200,
        );
      } finally {
        await restored.close();
      }
      // Revoked once, not again by the restarts after it.
      expect(
        await prisma.auditLogEntry.count({
          where: {
            action: "DEVICE_TOKEN_REVOKED",
            targetKind: "device-token",
            targetId: menu.id,
          },
        }),
      ).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

describe("a device route a later consent no longer names", () => {
  it("keeps its path readable across a narrower consent, a move, a removal and a reinstall", async () => {
    const prisma = new PrismaService(baseEnv);
    await prisma.$connect();
    try {
      // The board consents to a version without `menu`, and it is installed.
      await consent(prisma, CONSENTING, [SCREEN]);
      await writeManifest([SCREEN], CONSENTING);
      const narrowed = await boot(true);
      try {
        expect(
          narrowed.get(PluginLoaderService).get(CONSENTING),
        ).not.toBeNull();
        await expectReadableRefusal(narrowed, CONSENTING, "menu/today");
      } finally {
        await narrowed.close();
      }

      // Then to one that moves `screen` to another path.
      const moved = { id: "screen", path: "display" };
      await consent(prisma, CONSENTING, [moved]);
      await writeManifest([moved], CONSENTING);
      const relocated = await boot(true);
      try {
        expect(
          relocated.get(PluginLoaderService).get(CONSENTING),
        ).not.toBeNull();
        await expectReadableRefusal(relocated, CONSENTING, "screen/content");
        await expectReadableRefusal(relocated, CONSENTING, "menu/today");
      } finally {
        await relocated.close();
      }

      // Removed, and installed again with the moved route only.
      await new PluginRegistryService(prisma).remove(CONSENTING);
      await consent(prisma, CONSENTING, [moved]);
      const reinstalled = await boot(true);
      try {
        expect(
          reinstalled.get(PluginLoaderService).get(CONSENTING),
        ).not.toBeNull();
        await expectReadableRefusal(reinstalled, CONSENTING, "screen/content");
        await expectReadableRefusal(reinstalled, CONSENTING, "menu/today");
      } finally {
        await reinstalled.close();
      }
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

/**
 * Writes the rows a connected app's sign-in would have written for the board
 * member, with the access token bound to the resource this process resolved,
 * as `plugin-http.int-spec.ts` does.
 */
async function grantConnectedApp(
  app: NestFastifyApplication,
  prisma: PrismaService,
  token: string,
): Promise<void> {
  const auth = app.get(AuthService);
  if (
    (await prisma.user.findUnique({ where: { personId: board.personId } })) ===
    null
  ) {
    await auth.createAccountForPerson({
      personId: board.personId,
      email: board.email,
      name: "Styrelse",
      password: PASSWORD,
    });
  }
  const account = await prisma.user.findUniqueOrThrow({
    where: { personId: board.personId },
    select: { id: true },
  });
  const audience = [app.get<ProtectedResource>(PROTECTED_RESOURCE).url];
  const now = new Date();
  await prisma.oauthClient.create({
    data: {
      clientId: CONNECTED_APP,
      name: "En ansluten app",
      clientDiscoveryId: CONNECTED_APP,
      scopes: SCOPES,
      contacts: [],
      redirectUris: [`${new URL(CONNECTED_APP).origin}/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.oauthConsent.create({
    data: {
      clientId: CONNECTED_APP,
      userId: account.id,
      resources: audience,
      requestedUserInfoClaims: [],
      scopes: SCOPES,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.oauthAccessToken.create({
    data: {
      token: hashOpaqueToken(token),
      clientId: CONNECTED_APP,
      userId: account.id,
      resources: audience,
      requestedUserInfoClaims: [],
      scopes: SCOPES,
      expiresAt: new Date(Date.now() + 900_000),
      createdAt: now,
    },
  });
}

describe("a dropped device route's path a later version declares its protected resource", () => {
  it("refuses a device's token there with the device challenge, and answers a connected app as the resource", async () => {
    const prisma = new PrismaService(baseEnv);
    await prisma.$connect();
    try {
      const menu = await issueToken(prisma, "menu", RESOURCING);
      const screen = await issueToken(prisma, "screen", RESOURCING);

      // The same version, republished without `menu`, which now serves
      // connected apps on the path the devices were given.
      await writeManifest([SCREEN], RESOURCING, SERVER_ENTRY, "menu");
      try {
        const app = await boot(true);
        try {
          expect(app.get(PluginLoaderService).get(RESOURCING)).not.toBeNull();
          expect(app.get<ProtectedResource>(PROTECTED_RESOURCE)).toMatchObject({
            declared: true,
            path: `/api/plugin/${RESOURCING}/menu`,
          });
          expect(
            (
              await prisma.pluginDeviceToken.findUniqueOrThrow({
                where: { id: menu.id },
              })
            ).revokedAt,
          ).not.toBeNull();

          // The device given `menu` reads that its token is gone, on the
          // handler the resource mounts there and below it where none does.
          await expectReadableRefusal(
            app,
            RESOURCING,
            "menu/today",
            menu.token,
          );
          await expectReadableRefusal(
            app,
            RESOURCING,
            "menu/nowhere",
            menu.token,
          );
          // And a live token of another route is not a connected app's.
          await expectReadableRefusal(
            app,
            RESOURCING,
            "menu/today",
            screen.token,
          );

          // A connected app's token opens the resource.
          const access = `access-${suffix}`;
          await grantConnectedApp(app, prisma, access);
          const accepted = await inject(app, {
            method: "GET",
            url: `/api/plugin/${RESOURCING}/menu/today`,
            headers: { authorization: `Bearer ${access}` },
          });
          expect(accepted.statusCode).toBe(200);

          // One it does not know is told where a token comes from.
          const refused = await inject(app, {
            method: "GET",
            url: `/api/plugin/${RESOURCING}/menu/today`,
            headers: { authorization: `Bearer unknown-${suffix}` },
          });
          expect(refused.statusCode).toBe(401);
          expect(refused.headers["www-authenticate"]).toMatch(
            /^Bearer resource_metadata="/,
          );
          // And where no handler matched, nothing is turned into a device's.
          const unmatched = await inject(app, {
            method: "GET",
            url: `/api/plugin/${RESOURCING}/menu/nowhere`,
            headers: { authorization: `Bearer ${access}` },
          });
          expect(unmatched.statusCode).toBe(404);
          expect(unmatched.headers["www-authenticate"]).toBeUndefined();
        } finally {
          await app.close();
        }
      } finally {
        await writeManifest([SCREEN, MENU], RESOURCING);
      }
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

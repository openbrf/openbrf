import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { hashOpaqueToken } from "../auth/opaque-token";
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
const PASSWORD = "integration-password-1";
const ORIGIN = "app://tv.example";

const board = {
  personId: `devices-lifecycle-board-${suffix}`,
  email: `devices-lifecycle-board-${suffix}@exempel.se`,
};

const BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

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
  for (const [path, name] of [["screen/content", "content"], ["menu/today", "menu"], ["admin/tokens", "tokens"]]) {
    Get(path)(Screens.prototype, name, Object.getOwnPropertyDescriptor(Screens.prototype, name));
  }
  class LifecyclePluginModule {}
  Module({ controllers: [Screens] })(LifecyclePluginModule);
  return { module: LifecyclePluginModule };
};
`;

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

/** Writes the package's manifest, declaring the given device routes. */
async function writeManifest(
  deviceRoutes: { id: string; path: string }[],
  id = PLUGIN,
): Promise<void> {
  await writeFile(
    join(packageDirectory(id), "package.json"),
    JSON.stringify({
      name: `openbrf-plugin-${id}`,
      version: "1.0.0",
      openbrf: {
        apiVersion: 1,
        id,
        entry: { server: "./dist/server.cjs" },
        permissions: [],
        personalData: [],
        deviceRoutes,
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

const SCREEN = { id: "screen", path: "screen" };
const MENU = { id: "menu", path: "menu" };

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openbrf-device-lifecycle-"));
  const prisma = new PrismaService(baseEnv);
  await prisma.$connect();
  try {
    for (const [id, deviceRoutes] of [
      [PLUGIN, [SCREEN]],
      [DROPPING, [SCREEN, MENU]],
    ] as const) {
      const directory = packageDirectory(id);
      await mkdir(join(directory, "dist"), { recursive: true });
      await writeManifest([...deviceRoutes], id);
      await writeFile(join(directory, "dist", "server.cjs"), BUNDLE, "utf8");

      await prisma.installedPlugin.deleteMany({ where: { id } });
      await prisma.removedPluginDeviceRoute.deleteMany({
        where: { pluginId: id },
      });
      await new PluginRegistryService(prisma).consent({
        id,
        packageName: `openbrf-plugin-${id}`,
        version: "1.0.0",
        tarballUrl: `file:///dev/null/${id}.tgz`,
        checksum: "sha512-unused-in-this-suite",
        permissions: [],
        personalData: [],
        actions: [],
        deviceRoutes: [...deviceRoutes],
      });
      // On the volume, as the reconcile leaves a plugin it has installed.
      await prisma.installedPlugin.update({
        where: { id },
        data: { status: "INSTALLED" },
      });
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
      await prisma.pluginDeviceToken.deleteMany({
        where: { pluginId: { in: [PLUGIN, DROPPING] } },
      });
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: [PLUGIN, DROPPING] } },
      });
      await prisma.removedPluginDeviceRoute.deleteMany({
        where: { pluginId: { in: [PLUGIN, DROPPING] } },
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

/** A live token for one of the dropping plugin's routes, as issuing leaves it. */
async function issueToken(
  prisma: PrismaService,
  route: string,
): Promise<{ id: string; token: string }> {
  const token = mintDeviceToken();
  const row = await prisma.pluginDeviceToken.create({
    data: {
      pluginId: DROPPING,
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
      } finally {
        await dropped.close();
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

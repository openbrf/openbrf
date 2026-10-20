import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { dataPaths } from "../packaging/data-paths";
import { PluginRegistryService } from "../plugins/plugin-registry.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { DEVICE_TOKEN_PREFIX } from "./device-token";

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
    tokens() {
      return { tokens: [] };
    }
  }
  Controller()(Screens);
  for (const [path, name] of [["screen/content", "content"], ["admin/tokens", "tokens"]]) {
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

function packageDirectory(): string {
  return join(
    dataPaths(workspace).plugins,
    "node_modules",
    `openbrf-plugin-${PLUGIN}`,
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

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openbrf-device-lifecycle-"));
  const directory = packageDirectory();
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: `openbrf-plugin-${PLUGIN}`,
      version: "1.0.0",
      openbrf: {
        apiVersion: 1,
        id: PLUGIN,
        entry: { server: "./dist/server.cjs" },
        permissions: [],
        personalData: [],
        deviceRoutes: [{ id: "screen", path: "screen" }],
      },
    }),
    "utf8",
  );
  await writeFile(join(directory, "dist", "server.cjs"), BUNDLE, "utf8");

  const prisma = new PrismaService(baseEnv);
  await prisma.$connect();
  try {
    await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN } });
    await prisma.removedPluginDeviceRoute.deleteMany({
      where: { pluginId: PLUGIN },
    });
    await new PluginRegistryService(prisma).consent({
      id: PLUGIN,
      packageName: `openbrf-plugin-${PLUGIN}`,
      version: "1.0.0",
      tarballUrl: `file:///dev/null/${PLUGIN}.tgz`,
      checksum: "sha512-unused-in-this-suite",
      permissions: [],
      personalData: [],
      actions: [],
      deviceRoutes: [{ id: "screen", path: "screen" }],
    });
    // On the volume, as the reconcile leaves a plugin it has installed.
    await prisma.installedPlugin.update({
      where: { id: PLUGIN },
      data: { status: "INSTALLED" },
    });
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
      await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN } });
      await prisma.removedPluginDeviceRoute.deleteMany({
        where: { pluginId: PLUGIN },
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

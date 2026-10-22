import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import { AuthService } from "../auth/auth.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import { PrincipalService } from "../authorization/principal.service";
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
import { PluginLoaderService } from "../plugins/plugin-loader.service";
import { DEVICE_TOKEN_PREFIX, MAX_LIVE_DEVICE_TOKENS } from "./device-token";
import { DeviceTokenLimitError } from "./device-token.errors";
import { DeviceTokenService } from "./device-token.service";

/**
 * Device tokens and device routes, through the HTTP stack and against a real
 * database (ADR 0031).
 *
 * Two plugins on a volume of the suite's own, booted the way an instance boots
 * them. `SIGNAGE` declares two device routes, `screen` and `pictures`, and a
 * route of its own a board member issues tokens from; `OTHER` declares a
 * `screen` route as well, so a token can be tried somewhere it was not issued
 * for. `NESTED` declares a device route two segments deep beside an ordinary
 * route that takes any one segment. Nothing in the path from the request to the
 * token's row is stubbed.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
const SIGNAGE = `devices-${suffix}`;
const OTHER = `devices-other-${suffix}`;
/** Declares a device route the board never consented to. */
const WIDENED = `devices-widened-${suffix}`;
/** A device route at `screen/content`, beside an ordinary `GET :id`. */
const NESTED = `devices-nested-${suffix}`;
const PASSWORD = "integration-password-1";
const CALLS_PER_MINUTE = 6;

const board = {
  personId: `devices-board-${suffix}`,
  email: `devices-board-${suffix}@exempel.se`,
};

/**
 * The plugin's server bundle: what a plugin author writes, with the decorators
 * applied by hand because the bundle is plain CommonJS.
 */
const BUNDLE = `const { Body, Controller, Get, Module, Post, Req } = require("@nestjs/common");

exports.createPlugin = function createPlugin(host) {
  class Screens {
    content(request) {
      return { device: host.devices.current(request) };
    }
    picture(request) {
      return { route: host.devices.current(request).route };
    }
    async mint(request) {
      return host.devices.issue(request, { route: "screen", subject: "scr_minted", label: "Minted" });
    }
    async actions(request) {
      try {
        await host.actions.list(request);
        return { listed: true };
      } catch (cause) {
        return { listed: false };
      }
    }
    async issue(request, body) {
      return host.devices.issue(request, body);
    }
    async tokens() {
      return { tokens: await host.devices.list() };
    }
    async revoke(request, body) {
      return { revoked: await host.devices.revoke(body.id, request) };
    }
  }
  Controller()(Screens);
  const route = (decorator, name, params) => {
    decorator(Screens.prototype, name, Object.getOwnPropertyDescriptor(Screens.prototype, name));
    params.forEach((param, index) => param(Screens.prototype, name, index));
  };
  route(Get("screen/content"), "content", [Req()]);
  route(Get("pictures/one"), "picture", [Req()]);
  route(Get("screen/mint"), "mint", [Req()]);
  route(Get("screen/actions"), "actions", [Req()]);
  route(Post("admin/issue"), "issue", [Req(), Body()]);
  route(Get("admin/tokens"), "tokens", []);
  route(Post("admin/revoke"), "revoke", [Req(), Body()]);

  class DevicePluginModule {}
  Module({ controllers: [Screens] })(DevicePluginModule);
  return { module: DevicePluginModule };
};
`;

/** `NESTED`'s bundle: the device route's handler and an ordinary one. */
const NESTED_BUNDLE = `const { Controller, Get, Module, Param, Req } = require("@nestjs/common");

exports.createPlugin = function createPlugin(host) {
  class Nested {
    content(request) {
      return { device: host.devices.current(request).subject };
    }
    item(id) {
      return { item: id };
    }
  }
  Controller()(Nested);
  const route = (decorator, name, params) => {
    decorator(Nested.prototype, name, Object.getOwnPropertyDescriptor(Nested.prototype, name));
    params.forEach((param, index) => param(Nested.prototype, name, index));
  };
  route(Get("screen/content"), "content", [Req()]);
  route(Get(":id"), "item", [Param("id")]);

  class NestedPluginModule {}
  Module({ controllers: [Nested] })(NestedPluginModule);
  return { module: NestedPluginModule };
};
`;

let app: NestFastifyApplication | undefined;
let prisma: PrismaService;
let workspace: string | undefined;
let previousDataDir: string | undefined;
let boardCookie = "";

function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  // 10.131.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.131.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
}

function inject(options: {
  method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "OPTIONS";
  url: string;
  payload?: object;
  headers?: Record<string, string | string[]>;
  from?: string;
}) {
  const { from, ...rest } = options;
  return application()
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...rest,
      headers: {
        "x-forwarded-for": from ?? nextForwardedFor(),
        ...options.headers,
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

/** A token issued by the board member through the plugin's own route. */
async function issue(
  route = "screen",
  subject = "scr_1",
): Promise<{ token: string; id: string }> {
  const response = await inject({
    method: "POST",
    url: `/api/plugin/${SIGNAGE}/admin/issue`,
    headers: { cookie: boardCookie, origin: new URL(baseEnv.APP_URL).origin },
    payload: { route, subject, label: "Entrance B, ground floor" },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ token: string; device: { id: string } }>();
  return { token: body.token, id: body.device.id };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function writePlugin(
  root: string,
  id: string,
  deviceRoutes: { id: string; path: string }[],
  bundle = BUNDLE,
): Promise<void> {
  const directory = join(
    dataPaths(root).plugins,
    "node_modules",
    `openbrf-plugin-${id}`,
  );
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
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
  await writeFile(join(directory, "dist", "server.cjs"), bundle, "utf8");
}

beforeAll(async () => {
  const created = await mkdtemp(join(tmpdir(), "openbrf-device-routes-"));
  workspace = created;
  const signageRoutes = [
    { id: "screen", path: "screen" },
    { id: "pictures", path: "pictures" },
  ];
  await writePlugin(created, SIGNAGE, signageRoutes);
  await writePlugin(created, OTHER, [{ id: "screen", path: "screen" }]);
  await writePlugin(created, WIDENED, [{ id: "screen", path: "screen" }]);
  await writePlugin(
    created,
    NESTED,
    [{ id: "screen", path: "screen/content" }],
    NESTED_BUNDLE,
  );

  const env: Env = {
    ...baseEnv,
    OPENBRF_DATA_DIR: created,
    OPENBRF_PLUGINS_ENABLED: true,
    OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE: CALLS_PER_MINUTE,
  };

  const bootstrapPrisma = new PrismaService(env);
  await bootstrapPrisma.$connect();
  try {
    const registry = new PluginRegistryService(bootstrapPrisma);
    for (const [id, deviceRoutes] of [
      [SIGNAGE, signageRoutes],
      [OTHER, [{ id: "screen", path: "screen" }]],
      // Consented as the version before, which moved the route.
      [WIDENED, [{ id: "screen", path: "display" }]],
      [NESTED, [{ id: "screen", path: "screen/content" }]],
    ] as const) {
      await bootstrapPrisma.installedPlugin.deleteMany({ where: { id } });
      await registry.consent({
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
    }
  } finally {
    await bootstrapPrisma.$disconnect();
  }

  previousDataDir = process.env.OPENBRF_DATA_DIR;
  process.env.OPENBRF_DATA_DIR = created;
  const previousCalls = process.env.OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE;
  process.env.OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE = String(CALLS_PER_MINUTE);
  try {
    const started = await createApplication(await loadPluginsAtBoot(env));
    app = started;
    await started.init();
    await started.getHttpAdapter().getInstance().ready();
  } finally {
    restoreEnvironmentVariable(
      "OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE",
      previousCalls,
    );
  }
  prisma = application().get(PrismaService);

  const existing = await prisma.association.findUnique({ where: { id: 1 } });
  if (existing === null) {
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
    });
  }
  await prisma.person.create({
    data: { id: board.personId, firstName: "Styrelse", lastName: suffix },
  });
  // The administrator holds site:manage, which issuing a token needs.
  await prisma.systemRole.create({
    data: { personId: board.personId, role: "ADMIN" },
  });
  await application().get(AuthService).createAccountForPerson({
    personId: board.personId,
    email: board.email,
    name: "Styrelse",
    password: PASSWORD,
  });
  boardCookie = await signIn(board.email);
}, 180_000);

afterAll(async () => {
  try {
    if (app !== undefined) {
      const personId = board.personId;
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: [SIGNAGE, OTHER, WIDENED, NESTED] } },
      });
      await prisma.pluginDeviceRoutePath.deleteMany({
        where: { pluginId: { in: [SIGNAGE, OTHER, WIDENED, NESTED] } },
      });
      await prisma.systemRole.deleteMany({ where: { personId } });
      await prisma.user.deleteMany({ where: { personId } });
      await prisma.person.deleteMany({ where: { id: personId } });
      await app.close();
    }
  } finally {
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

describe("issuing a device token", () => {
  it("returns the token once, and keeps only its digest", async () => {
    const { token, id } = await issue();

    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    // The prefix and 32 random bytes in base64url.
    expect(token.length).toBe(DEVICE_TOKEN_PREFIX.length + 43);

    const row = await prisma.pluginDeviceToken.findUniqueOrThrow({
      where: { id },
    });
    expect(row.tokenHash).toBe(hashOpaqueToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({
      pluginId: SIGNAGE,
      routeId: "screen",
      subject: "scr_1",
      issuedByPersonId: board.personId,
      revokedAt: null,
    });

    const listed = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/admin/tokens`,
      headers: { cookie: boardCookie },
    });
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain(row.tokenHash);
  });

  it("records the act without the token, its digest or the board's label", async () => {
    const { token, id } = await issue("screen", "scr_audited");
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "DEVICE_TOKEN_ISSUED", targetId: id },
    });

    expect(entry).toMatchObject({
      channel: "PLUGIN",
      actorPersonId: board.personId,
      targetKind: "device-token",
    });
    const context = JSON.stringify(entry.context);
    expect(context).toContain(SIGNAGE);
    expect(context).not.toContain(token);
    expect(context).not.toContain(hashOpaqueToken(token));
    expect(context).not.toContain("Entrance B");
  });

  it("holds a plugin at 200 live tokens when two issues race at 199", async () => {
    const service = application().get(DeviceTokenService, { strict: false });
    const principal = await application()
      .get(PrincipalService, { strict: false })
      .forPerson(board.personId);
    const request = { principal };
    markAuthenticated(request, new LiveResponse(), {
      personId: board.personId,
      token: null,
      requestId: randomUUID(),
    });
    const live = await prisma.pluginDeviceToken.count({
      where: { pluginId: OTHER, revokedAt: null },
    });
    await prisma.pluginDeviceToken.createMany({
      data: Array.from(
        { length: MAX_LIVE_DEVICE_TOKENS - 1 - live },
        (_, index) => ({
          pluginId: OTHER,
          routeId: "screen",
          subject: `scr_filler_${String(index)}`,
          label: "Filler",
          tokenHash: `filler-${suffix}-${String(index)}`,
          issuedByPersonId: board.personId,
        }),
      ),
    });

    try {
      const results = await Promise.allSettled(
        ["scr_race_a", "scr_race_b"].map((subject) =>
          service.issue(OTHER, ["screen"], request, {
            route: "screen",
            subject,
            label: "Race",
          }),
        ),
      );

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused?.reason).toBeInstanceOf(DeviceTokenLimitError);
      expect(
        await prisma.pluginDeviceToken.count({
          where: { pluginId: OTHER, revokedAt: null },
        }),
      ).toBe(MAX_LIVE_DEVICE_TOKENS);
    } finally {
      await prisma.pluginDeviceToken.deleteMany({ where: { pluginId: OTHER } });
    }
  });

  it("is refused on a device's own request, which names no person", async () => {
    const { token } = await issue();

    const response = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/mint`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe(
      "device-token-issue-refused",
    );
  });
});

describe("a device route", () => {
  it("answers a live token for it, and tells the plugin which device asked", async () => {
    const { token, id } = await issue("screen", "scr_content");

    const response = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ device: { id: string; subject: string } }>().device,
    ).toMatchObject({ id, subject: "scr_content" });
    expect(response.headers["cache-control"]).toBe("no-store");

    const row = await prisma.pluginDeviceToken.findUniqueOrThrow({
      where: { id },
    });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("refuses the board member's own session", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="device"');
  });

  it("never reads a token from the query string", async () => {
    const { token } = await issue();

    const response = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content?access_token=${token}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("gives a device request no way into the action registry", async () => {
    const { token } = await issue();

    const response = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/actions`,
      headers: bearer(token),
    });
    expect(response.json<{ listed: boolean }>().listed).toBe(false);
  });
});

/**
 * A token reaches the one route of the one plugin it was issued for, and
 * nothing else on the instance: every other place answers it as it answers no
 * token at all.
 */
describe("a token outside its scope", () => {
  it("is refused on another device route of the same plugin", async () => {
    const { token } = await issue("screen");

    const response = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/pictures/one`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ reason: string }>().reason).toBe(
      "device-token-invalid",
    );
  });

  it("is refused on another plugin's device route of the same name", async () => {
    const { token } = await issue("screen");

    const response = await inject({
      method: "GET",
      url: `/api/plugin/${OTHER}/screen/content`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
  });

  it("is no credential on the plugin's other routes or the core's", async () => {
    const { token } = await issue("screen");

    for (const url of [
      `/api/plugin/${SIGNAGE}/admin/tokens`,
      "/api/me",
      "/api/devices",
    ]) {
      const response = await inject({
        method: "GET",
        url,
        headers: bearer(token),
      });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("cannot be used to write", async () => {
    const { token } = await issue("screen");

    const response = await inject({
      method: "POST",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: bearer(token),
      payload: {},
    });
    // The seal keeps a plugin from mounting a write under a device route, so
    // no handler answers a POST here and the router refuses it.
    expect(response.statusCode).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });
});

/**
 * The router reads `screen%2Fcontent` as one segment, which `:id` takes whole,
 * and that ordinary route is not a device route for being spelled like one.
 */
describe("an escaped slash in a path", () => {
  async function nestedToken(): Promise<string> {
    const principal = await application()
      .get(PrincipalService, { strict: false })
      .forPerson(board.personId);
    const request = { principal };
    markAuthenticated(request, new LiveResponse(), {
      personId: board.personId,
      token: null,
      requestId: randomUUID(),
    });
    const issued = await application()
      .get(DeviceTokenService, { strict: false })
      .issue(NESTED, ["screen"], request, {
        route: "screen",
        subject: "scr_nested",
        label: "Nested",
      });
    return issued.token;
  }

  it("does not let a device token open the ordinary route it reaches", async () => {
    const token = await nestedToken();

    const device = await inject({
      method: "GET",
      url: `/api/plugin/${NESTED}/screen/content`,
      headers: bearer(token),
    });
    expect(device.statusCode).toBe(200);
    expect(device.json<{ device: string }>().device).toBe("scr_nested");

    for (const spelling of ["screen%2Fcontent", "screen%2fcontent"]) {
      const url = `/api/plugin/${NESTED}/${spelling}`;
      const response = await inject({
        method: "GET",
        url,
        headers: { ...bearer(token), origin: "app://tv.example" },
      });
      expect(response.statusCode, url).toBe(401);
      expect(response.body, url).not.toContain('"item"');
      expect(response.headers["www-authenticate"], url).toBeUndefined();
      expect(
        response.headers["access-control-allow-origin"],
        url,
      ).toBeUndefined();
    }
  });

  it("leaves the ordinary route to the session it asks for", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/plugin/${NESTED}/screen%2Fcontent`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ item: string }>().item).toBe("screen/content");
  });
});

describe("revoking a device token", () => {
  it("from the board's devices screen cuts the next call", async () => {
    const { token, id } = await issue("screen", "scr_revoked_by_board");
    const before = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: bearer(token),
    });
    expect(before.statusCode).toBe(200);

    const listed = await inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie: boardCookie },
    });
    expect(listed.statusCode).toBe(200);
    const live = listed.json<{
      devices: { id: string; pluginId: string; issuedBy: { name: string } }[];
    }>().devices;
    expect(live.find((device) => device.id === id)).toMatchObject({
      pluginId: SIGNAGE,
      issuedBy: { name: `Styrelse ${suffix}` },
    });

    const revoked = await inject({
      method: "DELETE",
      url: `/api/devices/${id}`,
      headers: {
        cookie: boardCookie,
        origin: new URL(baseEnv.APP_URL).origin,
      },
    });
    expect(revoked.statusCode).toBe(200);

    const after = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: bearer(token),
    });
    expect(after.statusCode).toBe(401);
    expect(after.headers["www-authenticate"]).toBe('Bearer realm="device"');

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "DEVICE_TOKEN_REVOKED", targetId: id },
    });
    expect(entry).toMatchObject({
      channel: "WEB",
      actorPersonId: board.personId,
    });

    // Gone from the board's list, and a second press finds nothing to cut.
    const again = await inject({
      method: "DELETE",
      url: `/api/devices/${id}`,
      headers: {
        cookie: boardCookie,
        origin: new URL(baseEnv.APP_URL).origin,
      },
    });
    expect(again.statusCode).toBe(404);
  });

  it("from the plugin cuts the next call as well", async () => {
    const { token, id } = await issue("screen", "scr_revoked_by_plugin");

    const revoked = await inject({
      method: "POST",
      url: `/api/plugin/${SIGNAGE}/admin/revoke`,
      headers: {
        cookie: boardCookie,
        origin: new URL(baseEnv.APP_URL).origin,
      },
      payload: { id },
    });
    expect(revoked.json<{ revoked: boolean }>().revoked).toBe(true);

    const after = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: bearer(token),
    });
    expect(after.statusCode).toBe(401);
  });

  it("is refused to anybody who does not manage the website", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/devices",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("the per-token budget", () => {
  it("answers 429 with a delay once a token has spent its minute", async () => {
    const { token } = await issue("pictures", "scr_busy");
    const call = () =>
      inject({
        method: "GET",
        url: `/api/plugin/${SIGNAGE}/pictures/one`,
        headers: bearer(token),
      });

    for (let index = 0; index < CALLS_PER_MINUTE; index += 1) {
      expect((await call()).statusCode).toBe(200);
    }
    const refused = await call();
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused.headers["access-control-allow-origin"]).toBe("*");
  });
});

/**
 * The first CORS headers in the API, on device routes and nowhere else. A web
 * player on another origin has to be able to read every answer a device route
 * gives, the refusals most of all.
 */
describe("the headers a device route sends", () => {
  function expectDeviceHeaders(headers: Record<string, unknown>): void {
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["access-control-expose-headers"]).toBe(
      "ETag, Retry-After, WWW-Authenticate",
    );
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
    expect(headers["cache-control"]).toBe("no-store");
  }

  it("on a 200 and on a 401", async () => {
    const { token } = await issue();
    const ok = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: { ...bearer(token), origin: "app://tv.example" },
    });
    expect(ok.statusCode).toBe(200);
    expectDeviceHeaders(ok.headers);

    const refused = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: { origin: "app://tv.example" },
    });
    expect(refused.statusCode).toBe(401);
    expectDeviceHeaders(refused.headers);
  });

  it("answers the preflight itself", async () => {
    const response = await inject({
      method: "OPTIONS",
      url: `/api/plugin/${SIGNAGE}/screen/content`,
      headers: {
        origin: "app://tv.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(response.statusCode).toBe(204);
    expectDeviceHeaders(response.headers);
    expect(response.headers["access-control-allow-methods"]).toBe("GET, HEAD");
    expect(response.headers["access-control-allow-headers"]).toBe(
      "Authorization, If-None-Match",
    );
  });

  it("sends none anywhere else", async () => {
    for (const url of [
      "/health",
      "/api/me",
      `/api/plugin/${SIGNAGE}/admin/tokens`,
      `/api/plugin/${SIGNAGE}/screens`,
    ]) {
      const response = await inject({
        method: "GET",
        url,
        headers: { origin: "app://tv.example", cookie: boardCookie },
      });
      expect(response.headers["access-control-allow-origin"], url).toBe(
        undefined,
      );
    }
    const preflight = await inject({
      method: "OPTIONS",
      url: "/api/me",
      headers: {
        origin: "app://tv.example",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("a version that changes its device routes", () => {
  it("is not loaded while it declares a route the board has not consented to", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(WIDENED)).toBeNull();
    expect(
      loader.report().find((finding) => finding.id === WIDENED),
    ).toMatchObject({
      reason: "device-routes-widened",
      detail: { deviceRoutes: ["screen"] },
    });
  });

  it("takes the tokens of a route it drops with it when the board consents", async () => {
    const kept = await issue("screen", "scr_kept");
    const dropped = await issue("pictures", "scr_dropped");

    await prisma.$transaction(async (tx) => {
      await application()
        .get(DeviceTokenService, { strict: false })
        .revokeDroppedRoutes(SIGNAGE, ["screen"], board.personId, "WEB", tx);
    });

    const rows = await prisma.pluginDeviceToken.findMany({
      where: { id: { in: [kept.id, dropped.id] } },
    });
    expect(rows.find((row) => row.id === kept.id)?.revokedAt).toBeNull();
    expect(rows.find((row) => row.id === dropped.id)?.revokedAt).not.toBeNull();
    const after = await inject({
      method: "GET",
      url: `/api/plugin/${SIGNAGE}/pictures/one`,
      headers: bearer(dropped.token),
    });
    expect(after.statusCode).toBe(401);
  });
});

/**
 * Last, because switching a plugin back on takes effect at the next start, so
 * nothing after this case could reach it.
 */
describe("a device route of a plugin that is switched off", () => {
  it("answers 404 with the device headers, and keeps the token", async () => {
    const { token, id } = await issue();
    const origin = new URL(baseEnv.APP_URL).origin;
    const off = await inject({
      method: "PUT",
      url: `/api/plugins/${SIGNAGE}/enabled`,
      headers: { cookie: boardCookie, origin },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);

    try {
      const response = await inject({
        method: "GET",
        url: `/api/plugin/${SIGNAGE}/screen/content`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["cache-control"]).toBe("no-store");
      // Paused, not cut: the token is still live.
      const row = await prisma.pluginDeviceToken.findUniqueOrThrow({
        where: { id },
      });
      expect(row.revokedAt).toBeNull();
    } finally {
      await inject({
        method: "PUT",
        url: `/api/plugins/${SIGNAGE}/enabled`,
        headers: { cookie: boardCookie, origin },
        payload: { enabled: true },
      });
    }
  });
});

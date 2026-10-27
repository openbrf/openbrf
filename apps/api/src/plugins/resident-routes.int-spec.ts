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
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Resident routes through the real boot, the real router and a real database
 * (ADR 0051).
 *
 * The lifecycle under test is NestJS's: the seal decides what is mounted, the
 * application's guard who may call it, and the router when the plugin's code
 * runs and when NestJS subscribes to what a handler returned. A harness that
 * called the handler would test none of that, so plugins are written to a
 * volume of the suite's own and booted as an instance boots them.
 *
 * `PARKING` declares `offers` a resident route. It reads the register on its
 * board routes, keeps the board request it is serving in a singleton as a
 * NestJS service often keeps "the current request", and its resident routes
 * try the register and that kept request. `DECORATED` and `INHERITED` put a
 * custom parameter decorator that reads the register on a resident route's
 * handler, declared on it and inherited from a base class.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
const PARKING = `resident-parking-${suffix}`;
const DECORATED = `resident-decorated-${suffix}`;
const INHERITED = `resident-inherited-${suffix}`;
const PLUGINS = [PARKING, DECORATED, INHERITED];
const PASSWORD = "integration-password-1";

const address = `resident-address-${suffix}`;
const apartment = `resident-apartment-${suffix}`;
/** A name only the register holds, so a response carrying it read the register. */
const NEIGHBOUR_NAME = `Granne${suffix}`;

const persons = {
  /** Lives here and is listed to the plugins. */
  resident: `resident-resident-${suffix}`,
  /** Lives here too: what a register read would hand the resident. */
  neighbour: `resident-neighbour-${suffix}`,
  /** Lives here with protected personal data, so is listed to no plugin. */
  protectedOne: `resident-protected-${suffix}`,
  /** Holds the administrator's grant and does not live here. */
  board: `resident-board-${suffix}`,
  /** The property manager, an external party the address book never lists. */
  manager: `resident-manager-${suffix}`,
  /** Moved out, and kept an account. */
  former: `resident-former-${suffix}`,
};
const ACCOUNTS = [
  persons.resident,
  persons.protectedOne,
  persons.board,
  persons.manager,
  persons.former,
];

const cookies: Record<string, string> = {};

const RESIDENT_ROUTES = [{ path: "offers", titleKey: "residentRoutes.offers" }];

/**
 * `PARKING`'s server bundle: what a plugin author writes, with the decorators
 * applied by hand because the bundle is plain CommonJS.
 *
 * `Board.hold` keeps the board request it serves and stays unanswered until
 * `Board.free` is called, so the request is still being served, and its mark
 * still names the board member, while a resident's request uses it.
 * `Offers.kept` waits for a kept request when none is kept yet, which is how
 * the resident's request is made to begin first.
 */
const PARKING_BUNDLE = `const { Controller, Get, Module, Req, createParamDecorator } = require("@nestjs/common");
const { defer, from } = require("rxjs");

exports.createPlugin = function createPlugin(host) {
  const route = (target, decorator, name, params = []) => {
    decorator(target.prototype, name, Object.getOwnPropertyDescriptor(target.prototype, name));
    params.forEach((param, index) => param(target.prototype, name, index));
  };
  const outcome = async (work) => {
    try {
      await work();
      return "answered";
    } catch (cause) {
      return cause.name + " " + String(cause.member);
    }
  };

  let kept = null;
  const waiting = [];
  let release = () => {};

  class Board {
    async hold(request) {
      kept = request;
      waiting.splice(0).forEach((resume) => resume());
      await new Promise((resolve) => {
        release = resolve;
      });
      kept = null;
      return { held: true };
    }
    free() {
      release();
      return { freed: true };
    }
    state() {
      return { waiting: waiting.length, kept: kept !== null };
    }
    async residents() {
      return { names: (await host.addressBook.residents()).map((resident) => resident.name) };
    }
  }
  Controller("board")(Board);
  route(Board, Get("hold"), "hold", [Req()]);
  route(Board, Get("free"), "free");
  route(Board, Get("state"), "state");
  route(Board, Get("residents"), "residents");

  class Offers {
    async mine(request) {
      return { caller: (await host.addressBook.caller(request)).kind };
    }
    observable() {
      return defer(() => from(host.addressBook.residents()));
    }
    async observableAsync() {
      return defer(() => from(host.addressBook.residents()));
    }
    async promised() {
      return host.addressBook.residents();
    }
    async kept(request) {
      if (kept === null) {
        await new Promise((resume) => waiting.push(resume));
      }
      const board = kept;
      return {
        caller: await outcome(() => host.addressBook.caller(board)),
        list: await outcome(() => host.actions.list(board)),
        invoke: await outcome(() => host.actions.invoke(board, "resident.anything", {})),
        propose: await outcome(() => host.actions.propose(board, "resident.anything", {})),
        audit: await outcome(() => host.audit.record(board, { event: "offer.viewed" })),
        own: (await host.addressBook.caller(request)).kind,
        ownActions: Array.isArray(await host.actions.list(request)),
      };
    }
  }
  Controller("offers")(Offers);
  route(Offers, Get("mine"), "mine", [Req()]);
  route(Offers, Get("observable"), "observable");
  route(Offers, Get("observable-async"), "observableAsync");
  route(Offers, Get("promised"), "promised");
  route(Offers, Get("kept"), "kept", [Req()]);

  // A resident route's handler with no decorator of the plugin's, beside a
  // board route on the same controller that has one.
  const Register = createParamDecorator(() => host.addressBook.residents());
  class Mixed {
    plain() {
      return { plain: true };
    }
    decorated(residents) {
      return { names: residents.map((resident) => resident.name) };
    }
  }
  Controller()(Mixed);
  route(Mixed, Get("offers/plain"), "plain");
  route(Mixed, Get("board/decorated"), "decorated", [Register()]);

  class ParkingModule {}
  Module({ controllers: [Board, Offers, Mixed] })(ParkingModule);
  return { module: ParkingModule };
};
`;

/** A custom parameter decorator that reads the register, on the handler. */
const DECORATED_BUNDLE = `const { Controller, Get, Module, createParamDecorator } = require("@nestjs/common");

exports.createPlugin = function createPlugin(host) {
  const Register = createParamDecorator(() => host.addressBook.residents());
  class Offers {
    mine(residents) {
      return { names: residents.map((resident) => resident.name) };
    }
  }
  Controller("offers")(Offers);
  Get("mine")(Offers.prototype, "mine", Object.getOwnPropertyDescriptor(Offers.prototype, "mine"));
  Register()(Offers.prototype, "mine", 0);

  class DecoratedModule {}
  Module({ controllers: [Offers] })(DecoratedModule);
  return { module: DecoratedModule };
};
`;

/**
 * The same decorator inherited from a base class: the controller declares the
 * handler again with no decorator of its own, and NestJS reads the parameters
 * the base class declared for that name.
 */
const INHERITED_BUNDLE = `const { Controller, Get, Module, createParamDecorator } = require("@nestjs/common");

exports.createPlugin = function createPlugin(host) {
  const Register = createParamDecorator(() => host.addressBook.residents());
  class Base {
    mine(residents) {
      return residents;
    }
  }
  Register()(Base.prototype, "mine", 0);
  class Offers extends Base {
    mine(residents) {
      return { names: residents.map((resident) => resident.name) };
    }
  }
  Controller("offers")(Offers);
  Get("mine")(Offers.prototype, "mine", Object.getOwnPropertyDescriptor(Offers.prototype, "mine"));

  class InheritedModule {}
  Module({ controllers: [Offers] })(InheritedModule);
  return { module: InheritedModule };
};
`;

const BUNDLES: Record<string, string> = {
  [PARKING]: PARKING_BUNDLE,
  [DECORATED]: DECORATED_BUNDLE,
  [INHERITED]: INHERITED_BUNDLE,
};

let app: NestFastifyApplication | undefined;
let prisma: PrismaService;
let workspace: string | undefined;
let previousDataDir: string | undefined;

function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  // 10.151.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.151.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return application()
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: { "x-forwarded-for": nextForwardedFor(), ...options.headers },
    });
}

/** A GET of a plugin's route, as the person signed in with `cookie`. */
function get(pluginId: string, path: string, cookie: string) {
  return inject({
    method: "GET",
    url: `/api/plugin/${pluginId}/${path}`,
    headers: { cookie },
  });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return values.map((value) => value.split(";")[0]).join("; ");
}

/**
 * Waits until `PARKING`'s routes are where a test needs them: the resident's
 * waiting for a kept request, or the board's holding the request it serves.
 */
async function until(
  wanted: (state: { waiting: number; kept: boolean }) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await get(PARKING, "board/state", cookies.board ?? "");
    if (wanted(response.json<{ waiting: number; kept: boolean }>())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The request the test waits for never began.");
}

beforeAll(async () => {
  const created = await mkdtemp(join(tmpdir(), "openbrf-resident-routes-"));
  workspace = created;
  for (const id of PLUGINS) {
    const directory = join(
      dataPaths(created).plugins,
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
          permissions: ["addressBook:read"],
          personalData: ["name"],
          residentRoutes: RESIDENT_ROUTES,
        },
      }),
      "utf8",
    );
    await writeFile(
      join(directory, "dist", "server.cjs"),
      BUNDLES[id] ?? "",
      "utf8",
    );
  }

  const env: Env = {
    ...baseEnv,
    OPENBRF_DATA_DIR: created,
    OPENBRF_PLUGINS_ENABLED: true,
  };
  const bootstrapPrisma = new PrismaService(env);
  await bootstrapPrisma.$connect();
  try {
    const registry = new PluginRegistryService(bootstrapPrisma);
    for (const id of PLUGINS) {
      await bootstrapPrisma.installedPlugin.deleteMany({ where: { id } });
      await registry.consent({
        id,
        packageName: `openbrf-plugin-${id}`,
        version: "1.0.0",
        tarballUrl: `file:///dev/null/${id}.tgz`,
        checksum: "sha512-unused-in-this-suite",
        permissions: ["addressBook:read"],
        personalData: ["name"],
        actions: [],
        recipients: [],
        deviceRoutes: [],
        ai: false,
        licence: null,
      });
    }
  } finally {
    await bootstrapPrisma.$disconnect();
  }

  previousDataDir = process.env.OPENBRF_DATA_DIR;
  process.env.OPENBRF_DATA_DIR = created;
  const started = await createApplication(await loadPluginsAtBoot(env));
  app = started;
  await started.init();
  await started.getHttpAdapter().getInstance().ready();
  prisma = application().get(PrismaService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
    update: {},
  });
  await prisma.address.create({
    data: {
      id: address,
      street: "Parkgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 951,
    },
  });
  await prisma.apartment.create({
    data: { id: apartment, addressId: address, number: "1401" },
  });
  await prisma.person.createMany({
    data: Object.values(persons).map((id) => ({
      id,
      firstName: id === persons.neighbour ? NEIGHBOUR_NAME : "Förnamn",
      lastName: "Efternamn",
      protectedPersonalData: id === persons.protectedOne,
    })),
  });
  await prisma.residency.createMany({
    data: [
      ...[persons.resident, persons.neighbour, persons.protectedOne].map(
        (personId) => ({
          personId,
          apartmentId: apartment,
          role: "RESIDENT" as const,
          movedInOn: new Date("2020-01-01T00:00:00.000Z"),
        }),
      ),
      {
        personId: persons.former,
        apartmentId: apartment,
        role: "RESIDENT" as const,
        movedInOn: new Date("2020-01-01T00:00:00.000Z"),
        movedOutOn: new Date("2024-06-30T00:00:00.000Z"),
      },
    ],
  });
  await prisma.systemRole.createMany({
    data: [
      { personId: persons.board, role: "ADMIN" as const },
      { personId: persons.manager, role: "PROPERTY_MANAGER" as const },
    ],
  });
  for (const personId of ACCOUNTS) {
    const email = `${personId}@exempel.se`;
    await application().get(AuthService).createAccountForPerson({
      personId,
      email,
      name: "Förnamn",
      password: PASSWORD,
    });
    cookies[personId] = await signIn(email);
  }
  cookies.board = cookies[persons.board] ?? "";
}, 180_000);

afterAll(async () => {
  try {
    if (app !== undefined) {
      const personIds = Object.values(persons);
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: PLUGINS } },
      });
      await prisma.systemRole.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
      await prisma.apartment.deleteMany({ where: { id: apartment } });
      await prisma.address.deleteMany({ where: { id: address } });
      await app.close();
    }
  } finally {
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

describe("who may call a resident route", () => {
  it("answers a resident the address book lists, without a board seat", async () => {
    const response = await get(
      PARKING,
      "offers/mine",
      cookies[persons.resident] ?? "",
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ caller: "listed" });
  });

  it("refuses everybody else who holds self:manage alike, before the plugin's code runs", async () => {
    for (const personId of [
      persons.protectedOne,
      persons.board,
      persons.manager,
      persons.former,
    ]) {
      const response = await get(
        PARKING,
        "offers/mine",
        cookies[personId] ?? "",
      );

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        reason: "resident-route-not-listed",
      });
    }
  });

  it("keeps the plugin's other routes at the full floor", async () => {
    const resident = await get(
      PARKING,
      "board/residents",
      cookies[persons.resident] ?? "",
    );
    const board = await get(PARKING, "board/residents", cookies.board ?? "");

    expect(resident.statusCode).toBe(403);
    expect(board.statusCode).toBe(200);
    expect(board.json<{ names: string[] }>().names).toContain(
      `${NEIGHBOUR_NAME} Efternamn`,
    );
  });
});

describe("a custom parameter decorator on a resident route's handler", () => {
  it("refuses the plugin at load, declared on the handler or inherited", async () => {
    const loader = application().get(PluginLoaderService);

    for (const id of [DECORATED, INHERITED]) {
      expect(loader.get(id)).toBeNull();
      expect(
        loader.report().find((finding) => finding.id === id),
      ).toMatchObject({ reason: "module-refused" });
      const response = await get(
        id,
        "offers/mine",
        cookies[persons.resident] ?? "",
      );
      expect(response.statusCode).not.toBe(200);
      expect(response.body).not.toContain(NEIGHBOUR_NAME);
    }
  });

  it("leaves a decorator-free handler on the same controller to load and answer", async () => {
    expect(application().get(PluginLoaderService).get(PARKING)).not.toBeNull();

    const plain = await get(
      PARKING,
      "offers/plain",
      cookies[persons.resident] ?? "",
    );
    // The board route beside it keeps its decorator and the full floor.
    const decorated = await get(
      PARKING,
      "board/decorated",
      cookies.board ?? "",
    );

    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toEqual({ plain: true });
    expect(decorated.statusCode).toBe(200);
    expect(decorated.body).toContain(NEIGHBOUR_NAME);
  });
});

describe("a register read a resident route's handler defers", () => {
  it.each([
    ["an Observable", "offers/observable"],
    ["an Observable an async handler resolves to", "offers/observable-async"],
    ["a Promise", "offers/promised"],
  ])("never sends register data from %s", async (_kind, path) => {
    const response = await get(PARKING, path, cookies[persons.resident] ?? "");

    expect(response.body).not.toContain(NEIGHBOUR_NAME);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ reason: "plugin-handler-failed" });
  });
});

describe("a board request a plugin kept, used on a resident route", () => {
  const REFUSED = {
    caller: "PluginResidentRouteError addressBook.caller",
    list: "PluginResidentRouteError actions.list",
    invoke: "PluginResidentRouteError actions.invoke",
    propose: "PluginResidentRouteError actions.propose",
    audit: "PluginResidentRouteError audit.record",
    own: "listed",
    ownActions: true,
  };

  it("is refused while the resident's own request is served, when the board's began first", async () => {
    const held = get(PARKING, "board/hold", cookies.board ?? "");
    await until((state) => state.kept);

    const resident = await get(
      PARKING,
      "offers/kept",
      cookies[persons.resident] ?? "",
    );
    await get(PARKING, "board/free", cookies.board ?? "");

    expect(resident.statusCode).toBe(200);
    expect(resident.json()).toEqual(REFUSED);
    expect((await held).json()).toEqual({ held: true });
  });

  it("is refused while the resident's own request is served, when the resident's began first", async () => {
    const resident = get(
      PARKING,
      "offers/kept",
      cookies[persons.resident] ?? "",
    );
    await until((state) => state.waiting > 0);
    const held = get(PARKING, "board/hold", cookies.board ?? "");

    const answered = await resident;
    await get(PARKING, "board/free", cookies.board ?? "");

    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual(REFUSED);
    expect((await held).json()).toEqual({ held: true });
  });
});

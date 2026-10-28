import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { PluginPermission, PluginRecipient } from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { ActionRegistryService } from "../actions/action-registry.service";
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
import { PluginAuditService } from "./plugin-audit.service";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginPersonRecordsService } from "./plugin-person-records.service";
import {
  RECIPIENT_NETWORK,
  type RecipientNetwork,
} from "./plugin-recipients.service";
import {
  type PluginRecord,
  PluginRegistryService,
} from "./plugin-registry.service";
import { RESIDENT_ROUTE_OVERRUN_MS } from "./resident-route-scope";

/*
 * The consent to resident routes is not recorded with the install yet, so the
 * host serves none (`resident-routes-consent.ts`). The suite consents for every
 * plugin but `UNCONSENTED`, which tests that gate.
 */
vi.mock("./resident-routes-consent", () => ({
  residentRoutesConsented: (record: PluginRecord) =>
    !record.id.startsWith("resident-unconsented-"),
}));

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
 * try the register and that kept request, also from an Observable fed by a
 * Subject the plugin emits on outside any request, from a listener on a
 * Subject the handler awaits while a job or a board request emits, and from
 * the `toJSON` and the getters of what a handler answers with or throws. One
 * sends a disclosure about the person a resident's request names, and one never
 * answers. It also installs themes, which its resident routes try with the
 * kept request. `DECORATED` and `INHERITED` put a custom parameter decorator
 * that reads the register on a resident route's handler, declared on it and
 * inherited from a base class, and `HEADED` a response header whose value the
 * plugin computes.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
const PARKING = `resident-parking-${suffix}`;
const DECORATED = `resident-decorated-${suffix}`;
const INHERITED = `resident-inherited-${suffix}`;
const UNCONSENTED = `resident-unconsented-${suffix}`;
const HEADED = `resident-headed-${suffix}`;
const PLUGINS = [PARKING, DECORATED, INHERITED, UNCONSENTED, HEADED];
const PASSWORD = "integration-password-1";

const address = `resident-address-${suffix}`;
const apartment = `resident-apartment-${suffix}`;
/** A name only the register holds, so a response carrying it read the register. */
const NEIGHBOUR_NAME = `Granne${suffix}`;

/** An id the register does not hold. */
const UNKNOWN = `resident-unknown-${suffix}`;

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

/** The recipient `PARKING` declares; the suite's network double answers it. */
const PROVIDER: PluginRecipient = {
  id: "model-provider",
  origin: "https://api.example.com",
  purpose: { sv: "Språkmodellen", en: "The language model" },
  personalData: ["name"],
};

/**
 * `PARKING`'s server bundle: what a plugin author writes, with the decorators
 * applied by hand because the bundle is plain CommonJS.
 *
 * `Board.hold` keeps the board request it serves and stays unanswered until
 * `Board.free` is called, so the request is still being served, and its mark
 * still names the board member, while a resident's request uses it.
 * `Offers.kept` waits for a kept request when none is kept yet, which is how
 * the resident's request is made to begin first. `Offers.awaitedBoard` awaits
 * a listener on `boardEvents`, which only `Board.emit` feeds, from a board
 * member's request. `Offers.awaitedKept` and `awaitedKeptBoard` await a
 * listener that records an audit entry and dispatches an action with the kept
 * board request, fed by the plugin's ticker or by `Board.emitKept`, and
 * `Board.listened` reports what those calls came to.
 * `Offers.json` and `Offers.getters` answer with an object whose `toJSON` or
 * nested getter records an audit entry with the kept board request when it is
 * serialized, `Offers.throwingGetter` and `throwingBody` an HttpException
 * whose body does that, thrown by a getter of the answer or by the body of
 * the exception the handler throws, and `Board.serialized` reports how each of
 * those went. `Offers.disclose` sends a disclosure about the person it is
 * given to `PROVIDER`. `Offers.hang` never answers, and `Board.caller` reports
 * what `caller` answers a board route meanwhile. `Offers.kept` also tries
 * `actions.client` and `themes.install` with the kept board request, and
 * `Mixed.plain` sets a text header.
 */
const PARKING_BUNDLE = `const { ConflictException, Controller, Get, Header, Module, Param, Req, createParamDecorator } = require("@nestjs/common");
const { defer, firstValueFrom, from, mergeMap, Subject, take } = require("rxjs");

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
      return cause.name + " " + String(cause.member) + (cause.outside ? " outside" : "");
    }
  };

  // Fed from outside any request, as a job feeds what a plugin shares.
  const events = new Subject();
  const ticker = setInterval(() => events.next(), 20);
  const fromEvents = () =>
    events.pipe(
      take(1),
      mergeMap(async () => ({
        names: (await host.addressBook.residents()).map((resident) => resident.name),
      })),
    );
  // Fed only by a board member's request.
  const boardEvents = new Subject();
  const fromBoardEvents = () =>
    boardEvents.pipe(
      take(1),
      mergeMap(async () => ({
        names: (await host.addressBook.residents()).map((resident) => resident.name),
      })),
    );

  let kept = null;
  const waiting = [];
  let release = () => {};

  // Fed only by a board member's request, to a listener that uses the kept
  // board request. What each listener's calls came to, for Board.listened.
  const boardKeptEvents = new Subject();
  const listened = [];
  const usingKept = (source) =>
    source.pipe(
      take(1),
      mergeMap(async () => {
        const board = kept;
        const outcomes = Promise.all([
          outcome(() => host.audit.record(board, { event: "offer.viewed" })),
          outcome(() => host.actions.invoke(board, "resident.anything", {})),
        ]).then(([audit, invoke]) => ({ audit, invoke }));
        listened.push(outcomes);
        return await outcomes;
      }),
    );

  // How many requests Offers.hang has taken, none of which it answers.
  let hanging = 0;

  // What the kept board request was used for while an answer was serialized.
  const serialized = [];
  const auditKept = (event) => {
    const board = kept;
    serialized.push(outcome(() => host.audit.record(board, { event })));
  };
  // An exception whose body records such an entry when it is serialized.
  const auditingConflict = (event) =>
    new ConflictException({
      toJSON() {
        auditKept(event);
        return { message: "Taken" };
      },
    });

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
      return {
        waiting: waiting.length,
        kept: kept !== null,
        listening: boardEvents.observed,
        listeningKept: boardKeptEvents.observed,
        hanging,
      };
    }
    emit() {
      boardEvents.next();
      return { emitted: true };
    }
    emitKept() {
      boardKeptEvents.next();
      return { emitted: true };
    }
    async serialized() {
      return { outcomes: await Promise.all(serialized.splice(0)) };
    }
    async listened() {
      return { outcomes: await Promise.all(listened.splice(0)) };
    }
    async caller(request) {
      try {
        return { caller: (await host.addressBook.caller(request)).kind };
      } catch (cause) {
        return { caller: cause.name + " " + String(cause.member) + (cause.outside ? " outside" : "") };
      }
    }
    async residents() {
      return { names: (await host.addressBook.residents()).map((resident) => resident.name) };
    }
  }
  Controller("board")(Board);
  route(Board, Get("hold"), "hold", [Req()]);
  route(Board, Get("free"), "free");
  route(Board, Get("state"), "state");
  route(Board, Get("emit"), "emit");
  route(Board, Get("emit-kept"), "emitKept");
  route(Board, Get("serialized"), "serialized");
  route(Board, Get("listened"), "listened");
  route(Board, Get("caller"), "caller", [Req()]);
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
    subject() {
      return fromEvents();
    }
    async subjectAsync() {
      return fromEvents();
    }
    async promised() {
      return host.addressBook.residents();
    }
    async awaited() {
      return { neighbours: await firstValueFrom(fromEvents()) };
    }
    async awaitedBoard() {
      return { neighbours: await firstValueFrom(fromBoardEvents()) };
    }
    async awaitedKept() {
      return await firstValueFrom(usingKept(events));
    }
    async awaitedKeptBoard() {
      return await firstValueFrom(usingKept(boardKeptEvents));
    }
    json() {
      return {
        offer: {
          toJSON() {
            auditKept("offer.serialized");
            return { label: "Plats 4" };
          },
        },
      };
    }
    async getters() {
      return {
        offers: [
          {
            get label() {
              auditKept("offer.read");
              return "Plats 4";
            },
          },
        ],
      };
    }
    async throwingGetter() {
      return {
        get offer() {
          throw auditingConflict("offer.refused");
        },
      };
    }
    async throwingBody() {
      throw new ConflictException({
        toJSON() {
          throw auditingConflict("offer.refused");
        },
      });
    }
    async hang() {
      hanging += 1;
      await new Promise(() => {});
    }
    async disclose(subject) {
      try {
        await host.recipients.fetch("model-provider", "/v1/messages", {
          method: "POST",
          body: "{}",
          disclosure: { personalData: ["name"], subjects: [subject] },
        });
        return { disclosed: "sent" };
      } catch (cause) {
        return { disclosed: cause.name + " " + String(cause.code) };
      }
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
        client: await outcome(async () => host.actions.client(board)),
        audit: await outcome(() => host.audit.record(board, { event: "offer.viewed" })),
        theme: await outcome(() =>
          host.themes.install(board, new Uint8Array([1]), { sha512: "sha512-unchecked" }),
        ),
        own: (await host.addressBook.caller(request)).kind,
        ownActions: Array.isArray(await host.actions.list(request)),
      };
    }
  }
  Controller("offers")(Offers);
  route(Offers, Get("mine"), "mine", [Req()]);
  route(Offers, Get("observable"), "observable");
  route(Offers, Get("observable-async"), "observableAsync");
  route(Offers, Get("subject"), "subject");
  route(Offers, Get("subject-async"), "subjectAsync");
  route(Offers, Get("promised"), "promised");
  route(Offers, Get("awaited"), "awaited");
  route(Offers, Get("awaited-board"), "awaitedBoard");
  route(Offers, Get("awaited-kept"), "awaitedKept");
  route(Offers, Get("awaited-kept-board"), "awaitedKeptBoard");
  route(Offers, Get("json"), "json");
  route(Offers, Get("getters"), "getters");
  route(Offers, Get("throwing-getter"), "throwingGetter");
  route(Offers, Get("throwing-body"), "throwingBody");
  route(Offers, Get("hang"), "hang");
  route(Offers, Get("disclose/:subject"), "disclose", [Param("subject")]);
  route(Offers, Get("kept"), "kept", [Req()]);

  // A resident route's handler with no decorator of the plugin's but a text
  // header, beside a board route on the same controller that has one.
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
  Header("cache-control", "no-store")(Mixed.prototype, "plain", Object.getOwnPropertyDescriptor(Mixed.prototype, "plain"));
  route(Mixed, Get("board/decorated"), "decorated", [Register()]);

  class ParkingModule {
    onModuleDestroy() {
      clearInterval(ticker);
    }
  }
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

/**
 * A resident route's handler whose response header the plugin computes, which
 * NestJS would call before the scope is open, on every request. It reads the
 * register, as the header of a "who else is here" screen might.
 */
const HEADED_BUNDLE = `const { Controller, Get, Header, Module } = require("@nestjs/common");

exports.createPlugin = function createPlugin(host) {
  let names = "";
  class Offers {
    mine() {
      return { names };
    }
  }
  Controller("offers")(Offers);
  const descriptor = Object.getOwnPropertyDescriptor(Offers.prototype, "mine");
  Get("mine")(Offers.prototype, "mine", descriptor);
  Header("x-neighbours", () => {
    void host.addressBook.residents().then((residents) => {
      names = residents.map((resident) => resident.name).join(", ");
    });
    return names;
  })(Offers.prototype, "mine", descriptor);

  class HeadedModule {}
  Module({ controllers: [Offers] })(HeadedModule);
  return { module: HeadedModule };
};
`;

/**
 * A plain resident route on a plugin whose resident routes the board has not
 * consented to: the route must keep the plugin's full floor.
 */
const UNCONSENTED_BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

exports.createPlugin = function createPlugin() {
  class Offers {
    plain() {
      return { plain: true };
    }
  }
  Controller("offers")(Offers);
  Get("plain")(Offers.prototype, "plain", Object.getOwnPropertyDescriptor(Offers.prototype, "plain"));

  class UnconsentedModule {}
  Module({ controllers: [Offers] })(UnconsentedModule);
  return { module: UnconsentedModule };
};
`;

const BUNDLES: Record<string, string> = {
  [UNCONSENTED]: UNCONSENTED_BUNDLE,
  [PARKING]: PARKING_BUNDLE,
  [DECORATED]: DECORATED_BUNDLE,
  [INHERITED]: INHERITED_BUNDLE,
  [HEADED]: HEADED_BUNDLE,
};

/** `PARKING` also installs themes, as the administrator a request names. */
function permissionsOf(id: string): PluginPermission[] {
  return id === PARKING
    ? ["addressBook:read", "themes:install"]
    : ["addressBook:read"];
}

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

/** Where `PARKING`'s routes are, as `Board.state` reports it. */
interface ParkingState {
  waiting: number;
  kept: boolean;
  listening: boolean;
  listeningKept: boolean;
  hanging: number;
}

/**
 * Waits until `PARKING`'s routes are where a test needs them: the resident's
 * waiting for a kept request or listening on `boardEvents`, or the board's
 * holding the request it serves.
 */
async function until(wanted: (state: ParkingState) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await get(PARKING, "board/state", cookies.board ?? "");
    if (wanted(response.json<ParkingState>())) {
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
          permissions: permissionsOf(id),
          personalData: ["name"],
          residentRoutes: RESIDENT_ROUTES,
          recipients: id === PARKING ? [PROVIDER] : [],
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
        permissions: permissionsOf(id),
        personalData: ["name"],
        actions: [],
        recipients: id === PARKING ? [PROVIDER] : [],
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

describe("a resident route the board has not consented to", () => {
  it("keeps the plugin's full floor, so a resident is refused and the board is not", async () => {
    const resident = await get(
      UNCONSENTED,
      "offers/plain",
      cookies[persons.resident] ?? "",
    );
    const board = await get(UNCONSENTED, "offers/plain", cookies.board ?? "");

    expect(resident.statusCode).toBe(403);
    expect(resident.body).not.toContain("plain");
    expect(board.statusCode).toBe(200);
    expect(board.json()).toEqual({ plain: true });
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
    expect(plain.headers["cache-control"]).toBe("no-store");
    expect(decorated.statusCode).toBe(200);
    expect(decorated.body).toContain(NEIGHBOUR_NAME);
  });
});

/**
 * NestJS sets a route's headers before the interceptors run, so a header value
 * the plugin computes would run outside the scope, before the request it
 * answers is even known to be pending (F3 of the review).
 */
describe("a response header a resident route's handler computes", () => {
  it("refuses the plugin at load, so the header never reads the register", async () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(HEADED)).toBeNull();
    expect(
      loader.report().find((finding) => finding.id === HEADED),
    ).toMatchObject({ reason: "module-refused" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await get(
        HEADED,
        "offers/mine",
        cookies[persons.resident] ?? "",
      );
      expect(response.statusCode).not.toBe(200);
      expect(response.headers["x-neighbours"]).toBeUndefined();
      expect(response.body).not.toContain(NEIGHBOUR_NAME);
    }
  });
});

describe("a register read a resident route's handler defers", () => {
  it.each([
    ["an Observable", "offers/observable"],
    ["an Observable an async handler resolves to", "offers/observable-async"],
    ["an Observable a shared Subject feeds", "offers/subject"],
    [
      "an Observable a shared Subject feeds, an async handler resolves to",
      "offers/subject-async",
    ],
    ["a Promise", "offers/promised"],
  ])("never sends register data from %s", async (_kind, path) => {
    const response = await get(PARKING, path, cookies[persons.resident] ?? "");

    expect(response.body).not.toContain(NEIGHBOUR_NAME);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ reason: "plugin-handler-failed" });
  });
});

describe("a register read from a listener a resident route's handler awaits", () => {
  it("never sends register data when a job emits", async () => {
    const response = await get(
      PARKING,
      "offers/awaited",
      cookies[persons.resident] ?? "",
    );

    expect(response.body).not.toContain(NEIGHBOUR_NAME);
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      reason: "resident-route-timed-out",
    });
  });

  it("never sends register data when a board member's request emits, and answers the board", async () => {
    const resident = get(
      PARKING,
      "offers/awaited-board",
      cookies[persons.resident] ?? "",
    );
    await until((state) => state.listening);

    const emitted = await get(PARKING, "board/emit", cookies.board ?? "");
    const answered = await resident;

    expect(emitted.statusCode).toBe(200);
    expect(emitted.json()).toEqual({ emitted: true });
    expect(answered.body).not.toContain(NEIGHBOUR_NAME);
    expect(answered.statusCode).toBe(504);
    expect(answered.json()).toMatchObject({
      reason: "resident-route-timed-out",
    });
  });
});

describe("a board request a plugin kept, used on a resident route", () => {
  const REFUSED = {
    caller: "PluginResidentRouteError addressBook.caller",
    list: "PluginResidentRouteError actions.list",
    invoke: "PluginResidentRouteError actions.invoke",
    propose: "PluginResidentRouteError actions.propose",
    client: "PluginResidentRouteError actions.client",
    audit: "PluginResidentRouteError audit.record",
    theme: "PluginResidentRouteError themes.install",
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

/**
 * The work itself is held back, not only the answer: a listener the handler
 * awaits runs outside the scope, and a call it makes there waits for the
 * handler's answer, which cannot come before it. The handler's deadline runs
 * out instead, and the call that waited for it is refused before it records or
 * dispatches anything.
 */
describe("a kept board request, used by a listener a resident route's handler awaits", () => {
  it.each([
    ["a job emits", "offers/awaited-kept", null],
    [
      "a board member's request emits",
      "offers/awaited-kept-board",
      "board/emit-kept",
    ],
  ])(
    "never reaches the audit log or the actions when %s",
    async (_who, path, emit) => {
      const record = vi.spyOn(application().get(PluginAuditService), "record");
      const invoke = vi.spyOn(
        application().get(ActionRegistryService),
        "invoke",
      );
      const held = get(PARKING, "board/hold", cookies.board ?? "");
      try {
        await until((state) => state.kept);
        const resident = get(PARKING, path, cookies[persons.resident] ?? "");
        if (emit !== null) {
          await until((state) => state.listeningKept);
          const emitted = await get(PARKING, emit, cookies.board ?? "");
          expect(emitted.json()).toEqual({ emitted: true });
        }
        const answered = await resident;
        const listened = await get(
          PARKING,
          "board/listened",
          cookies.board ?? "",
        );

        expect(answered.statusCode).toBe(504);
        expect(answered.json()).toMatchObject({
          reason: "resident-route-timed-out",
        });
        expect(listened.json()).toEqual({
          outcomes: [
            {
              audit: "PluginResidentRouteError audit.record outside",
              invoke: "PluginResidentRouteError actions.invoke outside",
            },
          ],
        });
        expect(record).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
      } finally {
        await get(PARKING, "board/free", cookies.board ?? "");
        await held;
        record.mockRestore();
        invoke.mockRestore();
      }
    },
  );
});

/**
 * A handler that never answers, a long-poll whose event never comes or one
 * awaiting a recipient that is down, would hold off the plugin's narrowed calls
 * everywhere else, and fail each, for as long as it hangs (N1 of the review).
 * Its deadline bounds that: the request fails and a call that waited for it is
 * refused, and so is one made while its work goes on, for a while longer, as a
 * listener it awaits would make its next. Then the plugin's calls go ahead.
 */
describe("a resident route's handler that never answers", () => {
  it("fails at its deadline, refuses the plugin's calls meanwhile, and holds them for no longer than its overrun", async () => {
    const board = () => get(PARKING, "board/caller", cookies.board ?? "");
    const refused = {
      caller: "PluginResidentRouteError addressBook.caller outside",
    };
    const before = await board();
    const { hanging } = (
      await get(PARKING, "board/state", cookies.board ?? "")
    ).json<ParkingState>();

    const resident = get(
      PARKING,
      "offers/hang",
      cookies[persons.resident] ?? "",
    );
    await until((state) => state.hanging > hanging);
    const waited = await board();
    const answered = await resident;
    const overrunning = await board();
    let after = overrunning;
    const giveUp = Date.now() + RESIDENT_ROUTE_OVERRUN_MS + 5_000;
    while (after.json<{ caller: string }>().caller.includes("Error")) {
      if (Date.now() > giveUp) {
        throw new Error(
          "The plugin's calls were still refused after the overrun.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await board();
    }

    expect(answered.statusCode).toBe(504);
    expect(answered.json()).toMatchObject({
      reason: "resident-route-timed-out",
    });
    expect(waited.json()).toEqual(refused);
    expect(overrunning.json()).toEqual(refused);
    expect(before.statusCode).toBe(200);
    expect(before.json<{ caller: string }>().caller).not.toContain("Error");
    expect(after.json()).toEqual(before.json());
  }, 30_000);
});

/**
 * NestJS and Fastify serialize an answer after the handler has returned, and
 * an object's `toJSON` or getter is the plugin's code, so the host takes the
 * answer as data inside the scope, where the kept board request is refused.
 */
describe("what a resident route's handler answers with, serialized", () => {
  it.each([
    ["its toJSON", "offers/json", { offer: { label: "Plats 4" } }],
    ["a nested getter", "offers/getters", { offers: [{ label: "Plats 4" }] }],
  ])(
    "runs %s inside the scope, where the kept board request is refused",
    async (_kind, path, body) => {
      const record = vi.spyOn(application().get(PluginAuditService), "record");
      const held = get(PARKING, "board/hold", cookies.board ?? "");
      try {
        await until((state) => state.kept);
        const response = await get(
          PARKING,
          path,
          cookies[persons.resident] ?? "",
        );
        const serialized = await get(
          PARKING,
          "board/serialized",
          cookies.board ?? "",
        );

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(body);
        expect(serialized.json()).toEqual({
          outcomes: ["PluginResidentRouteError audit.record"],
        });
        expect(record).not.toHaveBeenCalled();
      } finally {
        await get(PARKING, "board/free", cookies.board ?? "");
        await held;
        record.mockRestore();
      }
    },
  );
});

/**
 * An HttpException is sent by NestJS's exception filter, after the handler has
 * returned, so the host takes its body as data inside the scope, also when a
 * getter of the answer throws it. When taking a body throws in turn, the
 * request fails as the plugin's failure and nothing more of it is taken.
 */
describe("an HttpException on a resident route, serialized", () => {
  it.each([
    [
      "a getter of the answer throws",
      "offers/throwing-getter",
      409,
      { message: "Taken" },
      ["PluginResidentRouteError audit.record"],
    ],
    [
      "taking the body of the one the handler throws throws",
      "offers/throwing-body",
      502,
      { reason: "plugin-handler-failed" },
      [],
    ],
  ])(
    "never reaches the audit log with the kept board request when %s",
    async (_how, path, status, body, outcomes) => {
      const record = vi.spyOn(application().get(PluginAuditService), "record");
      const held = get(PARKING, "board/hold", cookies.board ?? "");
      try {
        await until((state) => state.kept);
        const response = await get(
          PARKING,
          path,
          cookies[persons.resident] ?? "",
        );
        const serialized = await get(
          PARKING,
          "board/serialized",
          cookies.board ?? "",
        );

        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject(body);
        expect(serialized.json()).toEqual({ outcomes });
        expect(record).not.toHaveBeenCalled();
      } finally {
        await get(PARKING, "board/free", cookies.board ?? "");
        await held;
        record.mockRestore();
      }
    },
  );
});

/**
 * A disclosure on a resident route names the caller or a person the plugin
 * holds a readable record about. Anybody else is refused before the register
 * is asked about them, with the answer a protected person and an unknown id
 * get, so the three cannot be told apart, and nothing is sent.
 */
describe("a disclosure a resident route sends", () => {
  function spied() {
    const network = application().get<symbol, RecipientNetwork>(
      RECIPIENT_NETWORK,
    );
    return {
      resolve: vi
        .spyOn(network, "resolve")
        .mockResolvedValue([{ address: "93.184.215.14", family: 4 }]),
      send: vi.spyOn(network, "send").mockResolvedValue({
        status: 200,
        headers: {},
        body: Buffer.from("{}"),
      }),
      count: vi.spyOn(prisma.person, "count"),
      records: vi.spyOn(
        application().get(PluginPersonRecordsService),
        "holdsReadableRecordAbout",
      ),
    };
  }

  it.each([
    ["an id the register does not hold", UNKNOWN],
    ["a person with protected personal data", persons.protectedOne],
    ["a neighbour the address book lists", persons.neighbour],
  ])(
    "refuses %s alike, before anybody is looked up, and sends nothing",
    async (_who, subject) => {
      const { resolve, send, count, records } = spied();
      try {
        const response = await get(
          PARKING,
          `offers/disclose/${subject}`,
          cookies[persons.resident] ?? "",
        );

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          disclosed: "PluginRecipientError subject-refused",
        });
        expect(records.mock.calls).toEqual([[PARKING, subject]]);
        expect(count).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("sends one about the caller", async () => {
    const { send, count, records } = spied();
    try {
      const response = await get(
        PARKING,
        `offers/disclose/${persons.resident}`,
        cookies[persons.resident] ?? "",
      );

      expect(response.json()).toEqual({ disclosed: "sent" });
      expect(records).not.toHaveBeenCalled();
      expect(count).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type {
  PluginNonResidentCaller,
  PluginProcessing,
} from "@openbrf/plugin-sdk";
import { addLocalDays, dateColumnOf, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { ProcessingActivityService } from "../data-protection/processing-activity.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { dataPaths } from "../packaging/data-paths";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Who a resident route serves besides the people the address book lists
 * (ADR 0053), through the real boot, the real router, the application's guard
 * and a real database.
 *
 * `SERVING` declares every class of caller and the install approved them all.
 * Its resident route counts each time its handler runs, and its board route
 * reports the count, so a refusal is shown to have run no code of the
 * plugin's. `RESIDENTS` declares no class, `ONLY_ACCESS` declares only
 * `pluginAccess`, and `NARROWER` declares the board while its install also
 * approved the property manager, so an approved class the manifest does not
 * declare serves nobody. `WIDENED` declares the property manager, which its
 * install never approved, and is refused at load. `SIGNED_IN` offers its view
 * to every account.
 *
 * Each class (the board, the administrator, the property manager) has a
 * person in it with no residency, and one with each of the three refusals:
 * protected personal data, a restriction, and a standing objection to
 * `SERVING`'s processing. So has a resident. Former residents keep a seat or a
 * role, and the move-out date is today for one of them.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
const SERVING = `classes-serving-${suffix}`;
const RESIDENTS = `classes-residents-${suffix}`;
const ONLY_ACCESS = `classes-access-${suffix}`;
const NARROWER = `classes-narrower-${suffix}`;
const WIDENED = `classes-widened-${suffix}`;
const SIGNED_IN = `classes-signed-in-${suffix}`;
const PLUGINS = [SERVING, RESIDENTS, ONLY_ACCESS, NARROWER, WIDENED, SIGNED_IN];
const PASSWORD = "integration-password-1";

const EVERY_CLASS: PluginNonResidentCaller[] = [
  "board",
  "administrator",
  "propertyManager",
  "pluginAccess",
];

/** What each plugin's manifest declares, and what its install approved. */
const DECLARED: Record<string, PluginNonResidentCaller[] | undefined> = {
  [SERVING]: EVERY_CLASS,
  [RESIDENTS]: undefined,
  [ONLY_ACCESS]: ["pluginAccess"],
  [NARROWER]: ["board"],
  [WIDENED]: ["board", "propertyManager"],
  [SIGNED_IN]: undefined,
};
const APPROVED: Record<string, PluginNonResidentCaller[]> = {
  [SERVING]: EVERY_CLASS,
  [RESIDENTS]: [],
  [ONLY_ACCESS]: ["pluginAccess"],
  [NARROWER]: ["board", "propertyManager"],
  [WIDENED]: ["board"],
  [SIGNED_IN]: [],
};

const address = `classes-address-${suffix}`;
const apartment = `classes-apartment-${suffix}`;

const id = (name: string) => `classes-${name}-${suffix}`;

/** The three refusals, each a person in a class or a resident can be under. */
const REFUSALS = ["protected", "restricted", "objecting"] as const;
type Refusal = (typeof REFUSALS)[number];

/** Who a person is besides a refusal: a resident or somebody in one class. */
const STANDINGS = ["resident", "board", "administrator", "manager"] as const;
type Standing = (typeof STANDINGS)[number];

/** How a test's name reads a standing. */
const STANDING_NAMES: Record<Standing, string> = {
  resident: "resident",
  board: "board member who lives elsewhere",
  administrator: "administrator who lives elsewhere",
  manager: "property manager",
};

/** A person in each standing, with no refusal and with each one. */
function standingId(standing: Standing, refusal?: Refusal): string {
  return id(refusal === undefined ? standing : `${standing}-${refusal}`);
}

const persons = {
  /** Holds the administrator's grant and lives elsewhere: reads the count. */
  reader: id("reader"),
  /** In no class, with no residency: signed in and nothing else. */
  nobody: id("nobody"),
  /** Moved out, with nothing else. */
  former: id("former"),
  /** Moved out, and keeps a board seat that has not ended. */
  formerBoard: id("former-board"),
  /** Moved out, and keeps the administrator system role. */
  formerAdmin: id("former-admin"),
  /** Moved out, and keeps the property manager system role. */
  formerManager: id("former-manager"),
  /** Keeps a board seat and moves out today. */
  movingOutToday: id("moving-out-today"),
  /** Has never lived here and moves in tomorrow. */
  movingIn: id("moving-in"),
  /** Moves in tomorrow and holds a board seat today. */
  movingInBoard: id("moving-in-board"),
  /** Held a board seat that has ended, and never lived here. */
  endedSeat: id("ended-seat"),
  /** Moved out once and lives here again today. */
  returning: id("returning"),
};

const STANDING_IDS = STANDINGS.flatMap((standing) => [
  standingId(standing),
  ...REFUSALS.map((refusal) => standingId(standing, refusal)),
]);
const ACCOUNTS = [...STANDING_IDS, ...Object.values(persons)];

const cookies: Record<string, string> = {};

const RESIDENT_ROUTES = [{ path: "offers", titleKey: "residentRoutes.offers" }];

const PROCESSING: PluginProcessing = {
  purpose: {
    sv: "Låta grannar låna ut sina parkeringsplatser.",
    en: "Let neighbours lend each other their parking spaces.",
  },
  legalBasis: "contract",
  retention: { sv: "Två år.", en: "Two years." },
  dataSubjects: ["residents"],
};

/**
 * Every plugin's server bundle: a resident route that counts each time its
 * handler runs, and a board route that reports the count.
 */
const BUNDLE = `const { Controller, Get, Module } = require("@nestjs/common");

exports.createPlugin = function createPlugin() {
  let ran = 0;
  class Offers {
    mine() {
      ran += 1;
      return { served: true };
    }
  }
  Controller("offers")(Offers);
  Get("mine")(Offers.prototype, "mine", Object.getOwnPropertyDescriptor(Offers.prototype, "mine"));

  class Board {
    ran() {
      return { ran };
    }
  }
  Controller("board")(Board);
  Get("ran")(Board.prototype, "ran", Object.getOwnPropertyDescriptor(Board.prototype, "ran"));

  class ClassesModule {}
  Module({ controllers: [Offers, Board] })(ClassesModule);
  return { module: ClassesModule };
};
`;

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
  // 10.154.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.154.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
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
function get(pluginId: string, path: string, personId: string) {
  return inject({
    method: "GET",
    url: `/api/plugin/${pluginId}/${path}`,
    headers: { cookie: cookies[personId] ?? "" },
  });
}

/** How many times a plugin's resident route handler has run. */
async function ran(pluginId: string): Promise<number> {
  const response = await get(pluginId, "board/ran", persons.reader);
  expect(response.statusCode).toBe(200);
  return response.json<{ ran: number }>().ran;
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

/** Asserts the one refusal every person a resident route does not serve gets. */
function expectRefused(response: {
  statusCode: number;
  json: () => unknown;
}): void {
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    reason: "resident-route-not-listed",
  });
}

const today = localDayOf(new Date());
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");

beforeAll(async () => {
  const created = await mkdtemp(join(tmpdir(), "openbrf-classes-"));
  workspace = created;
  for (const pluginId of PLUGINS) {
    const directory = join(
      dataPaths(created).plugins,
      "node_modules",
      `openbrf-plugin-${pluginId}`,
    );
    await mkdir(join(directory, "dist"), { recursive: true });
    const declared = DECLARED[pluginId];
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: `openbrf-plugin-${pluginId}`,
        version: "1.0.0",
        openbrf: {
          apiVersion: 1,
          id: pluginId,
          entry: { server: "./dist/server.cjs" },
          permissions: ["addressBook:read"],
          personalData: ["name"],
          processing: PROCESSING,
          residentRoutes: RESIDENT_ROUTES,
          ...(declared === undefined ? {} : { nonResidentCallers: declared }),
          view: {
            titleKey: "view.title",
            section: "building",
            ...(pluginId === SIGNED_IN ? { offeredTo: "signedIn" } : {}),
          },
        },
      }),
      "utf8",
    );
    await writeFile(join(directory, "dist", "server.cjs"), BUNDLE, "utf8");
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
    for (const pluginId of PLUGINS) {
      await bootstrapPrisma.installedPlugin.deleteMany({
        where: { id: pluginId },
      });
      await registry.consent({
        id: pluginId,
        packageName: `openbrf-plugin-${pluginId}`,
        version: "1.0.0",
        tarballUrl: `file:///dev/null/${pluginId}.tgz`,
        checksum: "sha512-unused-in-this-suite",
        permissions: ["addressBook:read"],
        personalData: ["name"],
        actions: [],
        recipients: [],
        deviceRoutes: [],
        residentRoutes: RESIDENT_ROUTES,
        nonResidentCallers: APPROVED[pluginId] ?? [],
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
      street: "Klassgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 953,
    },
  });
  await prisma.apartment.create({
    data: { id: apartment, addressId: address, number: "1501" },
  });

  const restrictedAt = new Date();
  await prisma.person.createMany({
    data: ACCOUNTS.map((personId) => ({
      id: personId,
      firstName: "Förnamn",
      lastName: "Efternamn",
      protectedPersonalData: personId.includes("-protected-"),
      processingRestrictedAt: personId.includes("-restricted-")
        ? restrictedAt
        : null,
    })),
  });

  const todayColumn = dateColumnOf(today);
  const tomorrow = dateColumnOf(addLocalDays(today, 1));
  const residency = (
    personId: string,
    movedInOn: Date,
    movedOutOn: Date | null = null,
  ) => ({
    personId,
    apartmentId: apartment,
    role: "RESIDENT" as const,
    movedInOn,
    movedOutOn,
  });
  const MOVED_OUT = new Date("2024-06-30T00:00:00.000Z");
  await prisma.residency.createMany({
    data: [
      ...[undefined, ...REFUSALS].map((refusal) =>
        residency(standingId("resident", refusal), LONG_AGO),
      ),
      residency(persons.former, LONG_AGO, MOVED_OUT),
      residency(persons.formerBoard, LONG_AGO, MOVED_OUT),
      residency(persons.formerAdmin, LONG_AGO, MOVED_OUT),
      residency(persons.formerManager, LONG_AGO, MOVED_OUT),
      residency(persons.movingOutToday, LONG_AGO, todayColumn),
      residency(persons.movingIn, tomorrow),
      residency(persons.movingInBoard, tomorrow),
      residency(persons.returning, LONG_AGO, MOVED_OUT),
      residency(persons.returning, new Date("2025-01-01T00:00:00.000Z")),
    ],
  });

  const seat = (personId: string, endedOn: Date | null = null) => ({
    personId,
    position: "BOARD_MEMBER" as const,
    electedOn: LONG_AGO,
    endedOn,
  });
  await prisma.boardPosition.createMany({
    data: [
      ...[undefined, ...REFUSALS].map((refusal) =>
        seat(standingId("board", refusal)),
      ),
      seat(persons.formerBoard),
      seat(persons.movingOutToday),
      seat(persons.movingInBoard),
      seat(persons.endedSeat, new Date("2025-06-30T00:00:00.000Z")),
    ],
  });
  await prisma.systemRole.createMany({
    data: [
      ...[undefined, ...REFUSALS].map((refusal) => ({
        personId: standingId("administrator", refusal),
        role: "ADMIN" as const,
      })),
      ...[undefined, ...REFUSALS].map((refusal) => ({
        personId: standingId("manager", refusal),
        role: "PROPERTY_MANAGER" as const,
      })),
      { personId: persons.reader, role: "ADMIN" as const },
      { personId: persons.formerAdmin, role: "ADMIN" as const },
      { personId: persons.formerManager, role: "PROPERTY_MANAGER" as const },
    ],
  });

  // A standing objection to `SERVING`'s processing, granted by the board.
  const processing = application().get(ProcessingActivityService);
  await processing.seedPlugin(SERVING, {
    name: "Parkering",
    permissions: ["addressBook:read"],
    personalDataCategories: ["name"],
    processing: PROCESSING,
  });
  const activity = await prisma.processingActivity.findUniqueOrThrow({
    where: { sourceKey: pluginProcessorKey(SERVING) },
    select: { id: true },
  });
  await prisma.dataSubjectRequest.createMany({
    data: STANDINGS.map((standing) => ({
      personId: standingId(standing, "objecting"),
      kind: "OBJECTION" as const,
      requestedOn: LONG_AGO,
      ground: "Vill inte vara med.",
      processingActivityId: activity.id,
      decision: "GRANTED" as const,
      decidedAt: LONG_AGO,
      recordedByPersonId: persons.reader,
      decidedByPersonId: persons.reader,
    })),
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
}, 180_000);

afterAll(async () => {
  try {
    if (app !== undefined) {
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: PLUGINS } },
      });
      await prisma.dataSubjectRequest.deleteMany({
        where: { personId: { in: ACCOUNTS } },
      });
      await prisma.processingActivity.deleteMany({
        where: { sourceKey: pluginProcessorKey(SERVING) },
      });
      await prisma.systemRole.deleteMany({
        where: { personId: { in: ACCOUNTS } },
      });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: ACCOUNTS } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: ACCOUNTS } } });
      await prisma.residency.deleteMany({
        where: { personId: { in: ACCOUNTS } },
      });
      await prisma.person.deleteMany({ where: { id: { in: ACCOUNTS } } });
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

describe("a resident route that declares every class of caller", () => {
  it.each(STANDINGS.map((standing) => [STANDING_NAMES[standing], standing]))(
    "serves a %s with no refusal, and runs the handler",
    async (_, standing) => {
      const before = await ran(SERVING);
      const response = await get(SERVING, "offers/mine", standingId(standing));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ served: true });
      expect(await ran(SERVING)).toBe(before + 1);
    },
  );

  it.each(
    STANDINGS.flatMap((standing) =>
      REFUSALS.map(
        (refusal) => [STANDING_NAMES[standing], refusal, standing] as const,
      ),
    ),
  )(
    "refuses a %s who is %s, before any of the plugin's code runs",
    async (_, refusal, standing) => {
      const before = await ran(SERVING);
      const response = await get(
        SERVING,
        "offers/mine",
        standingId(standing, refusal),
      );

      expectRefused(response);
      expect(await ran(SERVING)).toBe(before);
    },
  );

  it.each([
    ["a former resident", persons.former],
    ["a former resident who keeps a board seat", persons.formerBoard],
    ["a former resident who keeps the administrator role", persons.formerAdmin],
    [
      "a former resident who keeps the property manager role",
      persons.formerManager,
    ],
    ["a board member whose move-out date is today", persons.movingOutToday],
    ["a person in no class", persons.nobody],
    ["a person whose only residency begins tomorrow", persons.movingIn],
    ["a person whose board seat has ended", persons.endedSeat],
  ])("refuses %s", async (_, personId) => {
    const before = await ran(SERVING);

    expectRefused(await get(SERVING, "offers/mine", personId));
    expect(await ran(SERVING)).toBe(before);
  });

  it.each([
    [
      "a person who moves in tomorrow and holds a board seat today",
      persons.movingInBoard,
    ],
    ["a former resident who lives here again today", persons.returning],
  ])("serves %s", async (_, personId) => {
    const response = await get(SERVING, "offers/mine", personId);

    expect(response.statusCode).toBe(200);
  });

  it("answers every refused person with the same status and body, byte for byte", async () => {
    const refused = [
      ...STANDINGS.flatMap((standing) =>
        REFUSALS.map((refusal) => standingId(standing, refusal)),
      ),
      persons.former,
      persons.formerBoard,
      persons.formerAdmin,
      persons.formerManager,
      persons.movingOutToday,
      persons.nobody,
    ];
    const answers = await Promise.all(
      refused.map(async (personId) => {
        const response = await get(SERVING, "offers/mine", personId);
        return `${String(response.statusCode)} ${response.body}`;
      }),
    );

    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain("resident-route-not-listed");
  });

  it("serves a board member who moves out today as a resident the day before, and refuses them on the day", async () => {
    // The guard asks the predicate with the request's own instant; the day
    // before is asked of the predicate itself, on the association's calendar.
    const addressBook = application().get(PluginAddressBookService);
    const classes = await addressBook.servedClasses(SERVING, EVERY_CLASS);
    const noon = (day: typeof today) =>
      new Date(`${dateColumnOf(day).toISOString().slice(0, 10)}T10:00:00Z`);

    expect(
      await addressBook.isServed(
        SERVING,
        persons.movingOutToday,
        classes,
        noon(addLocalDays(today, -1)),
      ),
    ).toBe(true);
    expect(
      await addressBook.isServed(
        SERVING,
        persons.movingOutToday,
        classes,
        noon(today),
      ),
    ).toBe(false);
    expect(
      await addressBook.isOffered(
        persons.movingOutToday,
        classes,
        noon(addLocalDays(today, -1)),
      ),
    ).toBe(true);
    expect(
      await addressBook.isOffered(persons.movingOutToday, classes, noon(today)),
    ).toBe(false);
  });

  it("keeps the plugin's other routes at the full floor for everybody it serves", async () => {
    for (const personId of [standingId("resident"), standingId("manager")]) {
      const response = await get(SERVING, "board/ran", personId);
      expect(response.statusCode).toBe(403);
      expect(response.json()).not.toMatchObject({
        reason: "resident-route-not-listed",
      });
    }
    expect(
      (await get(SERVING, "board/ran", standingId("board"))).statusCode,
    ).toBe(200);
  });
});

describe("a resident route that declares fewer classes", () => {
  it("serves only residents when the plugin declares no class", async () => {
    expect(
      (await get(RESIDENTS, "offers/mine", standingId("resident"))).statusCode,
    ).toBe(200);
    for (const standing of ["board", "administrator", "manager"] as const) {
      expectRefused(await get(RESIDENTS, "offers/mine", standingId(standing)));
    }
  });

  it("refuses a person in a class the plugin does not declare", async () => {
    // pluginAccess serves nobody until the host keeps plugin accesses.
    for (const standing of ["board", "administrator", "manager"] as const) {
      expectRefused(
        await get(ONLY_ACCESS, "offers/mine", standingId(standing)),
      );
    }
    expect(
      (await get(ONLY_ACCESS, "offers/mine", standingId("resident")))
        .statusCode,
    ).toBe(200);
  });

  it("refuses a person in a class the install approved that the manifest does not declare", async () => {
    expect(
      (await get(NARROWER, "offers/mine", standingId("board"))).statusCode,
    ).toBe(200);
    expectRefused(await get(NARROWER, "offers/mine", standingId("manager")));
  });
});

describe("a class the install never approved", () => {
  it("refuses the plugin at load as widened resident routes, naming the class", () => {
    const loader = application().get(PluginLoaderService);

    expect(loader.get(WIDENED)).toBeNull();
    expect(
      loader.report().find((finding) => finding.id === WIDENED),
    ).toMatchObject({
      reason: "resident-routes-widened",
      detail: { nonResidentCallers: ["propertyManager"] },
    });
  });
});

describe("the navigation", () => {
  async function sectionOf(
    pluginId: string,
    personId: string,
  ): Promise<string | null | undefined> {
    const response = await inject({
      method: "GET",
      url: "/api/plugin-views",
      headers: { cookie: cookies[personId] ?? "" },
    });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ views: { id: string; section: string | null }[] }>()
      .views.find((view) => view.id === pluginId)?.section;
  }

  it("offers the view to a resident and to a person in a declared class", async () => {
    for (const personId of [
      standingId("resident"),
      standingId("board"),
      standingId("administrator"),
      standingId("manager"),
      persons.movingInBoard,
    ]) {
      expect(await sectionOf(SERVING, personId)).toBe("building");
    }
  });

  it("does not read the three refusals, so a withheld person in a class is offered it", async () => {
    for (const refusal of REFUSALS) {
      expect(await sectionOf(SERVING, standingId("manager", refusal))).toBe(
        "building",
      );
    }
  });

  it("does not offer it to a former resident in a declared class, nor to a person in no class", async () => {
    for (const personId of [
      persons.former,
      persons.formerBoard,
      persons.formerAdmin,
      persons.formerManager,
      persons.movingOutToday,
      persons.nobody,
    ]) {
      expect(await sectionOf(SERVING, personId)).toBeNull();
    }
  });

  it("does not offer it in a class the plugin does not declare or the install did not approve", async () => {
    expect(await sectionOf(RESIDENTS, standingId("board"))).toBeNull();
    expect(await sectionOf(ONLY_ACCESS, standingId("board"))).toBeNull();
    expect(await sectionOf(NARROWER, standingId("manager"))).toBeNull();
    expect(await sectionOf(NARROWER, standingId("board"))).toBe("building");
  });

  it("offers a view offered to everybody signed in to every account, while its routes still refuse", async () => {
    for (const personId of [
      persons.nobody,
      persons.former,
      persons.formerBoard,
    ]) {
      expect(await sectionOf(SIGNED_IN, personId)).toBe("building");
      expectRefused(await get(SIGNED_IN, "offers/mine", personId));
    }
  });
});

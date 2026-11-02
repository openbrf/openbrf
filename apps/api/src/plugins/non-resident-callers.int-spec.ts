import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type {
  PluginNonResidentCaller,
  PluginPermission,
  PluginPersonRecordCollection,
  PluginProcessing,
} from "@openbrf/plugin-sdk";
import { addLocalDays, dateColumnOf, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { ProcessingActivityService } from "../data-protection/processing-activity.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { MailService } from "../mail/mail.service";
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
 * approved the property manager and `pluginAccess`, so an approved class the
 * manifest does not declare serves nobody. `WIDENED` declares the property manager, which its
 * install never approved, and is refused at load. `SIGNED_IN` offers its view
 * to every account. `RECORDS` declares every class too, and its routes call
 * the host, for what the plugin reads of and writes about these people:
 * `nonResidents()`, `caller`, the subject of a record or an audit entry, and
 * mail.
 *
 * Each class (the board, the administrator, the property manager, a plugin
 * access to `SERVING`) has a person in it with no residency, and one with each
 * of the three refusals: protected personal data, a restriction, and a
 * standing objection to `SERVING`'s processing. So has a resident. Former
 * residents keep a seat, a role or an access, and the move-out date is today
 * for one of them. The board grants an access over HTTP too, so the grant is
 * checked against the plugins this boot really loaded.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
const SERVING = `classes-serving-${suffix}`;
const RESIDENTS = `classes-residents-${suffix}`;
const ONLY_ACCESS = `classes-access-${suffix}`;
const NARROWER = `classes-narrower-${suffix}`;
const WIDENED = `classes-widened-${suffix}`;
const SIGNED_IN = `classes-signed-in-${suffix}`;
const RECORDS = `classes-records-${suffix}`;
const PLUGINS = [
  SERVING,
  RESIDENTS,
  ONLY_ACCESS,
  NARROWER,
  WIDENED,
  SIGNED_IN,
  RECORDS,
];
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
  [RECORDS]: EVERY_CLASS,
};
const APPROVED: Record<string, PluginNonResidentCaller[]> = {
  [SERVING]: EVERY_CLASS,
  [RESIDENTS]: [],
  [ONLY_ACCESS]: ["pluginAccess"],
  [NARROWER]: ["board", "propertyManager", "pluginAccess"],
  [WIDENED]: ["board"],
  [SIGNED_IN]: [],
  [RECORDS]: EVERY_CLASS,
};

/** What `RECORDS` reads and writes beyond the others, and the board consented to. */
const RECORDS_PERMISSIONS: PluginPermission[] = [
  "addressBook:read",
  "addressBook:readContact",
  "mail:send",
];
const ASSIGNMENTS: PluginPersonRecordCollection = {
  collection: "assignments",
  titleKey: "records.assignments.title",
  personalData: ["name"],
  keepAtMostDays: 400,
  fields: [
    { key: "space", labelKey: "records.assignments.space", provided: false },
  ],
};

const address = `classes-address-${suffix}`;
const apartment = `classes-apartment-${suffix}`;

const id = (name: string) => `classes-${name}-${suffix}`;

/** The three refusals, each a person in a class or a resident can be under. */
const REFUSALS = ["protected", "restricted", "objecting"] as const;
type Refusal = (typeof REFUSALS)[number];

/** Who a person is besides a refusal: a resident or somebody in one class. */
const STANDINGS = [
  "resident",
  "board",
  "administrator",
  "manager",
  "granted",
] as const;
type Standing = (typeof STANDINGS)[number];

/** How a test's name reads a standing. */
const STANDING_NAMES: Record<Standing, string> = {
  resident: "resident",
  board: "board member who lives elsewhere",
  administrator: "administrator who lives elsewhere",
  manager: "property manager",
  granted: "person given access to the plugin",
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
  /** Holds a board seat, and has a space assigned before the seat ends. */
  leavingBoard: id("leaving-board"),
  /**
   * Moved out, and holds an access to `SERVING`: a row the grant and the
   * move-in never leave, written here to show it serves nobody.
   */
  formerGranted: id("former-granted"),
  /**
   * Holds an access to `ONLY_ACCESS`, to `RESIDENTS` and to `NARROWER`, and
   * none to `SERVING`.
   */
  grantedElsewhere: id("granted-elsewhere"),
  /** Holds an access to `SERVING` that a test withdraws. */
  withdrawn: id("withdrawn"),
  /** Has never lived here and holds no access until a test grants one. */
  candidate: id("candidate"),
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

/**
 * `RECORDS`'s server bundle. Its routes call the host and report what came of
 * it: the answer, or the refusal's name and the member it names. A board route
 * assigns a space to a person, as the board's assignment to a garage renter is
 * written, and records an audit entry about them.
 */
const RECORDS_BUNDLE = `const { Body, Controller, Get, Module, Post, Query, Req } = require("@nestjs/common");

exports.createPlugin = function createPlugin(host) {
  const route = (target, decorator, name, params = []) => {
    decorator(target.prototype, name, Object.getOwnPropertyDescriptor(target.prototype, name));
    params.forEach((param, index) => param(target.prototype, name, index));
  };
  const outcome = async (work) => {
    try {
      return { answered: await work() };
    } catch (cause) {
      return { refused: cause.name + (cause.member ? " " + cause.member : "") };
    }
  };
  const eraseOn = () =>
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const assign = (key, subject) =>
    outcome(async () =>
      (await host.personRecords.put("assignments", key, {
        subject,
        eraseOn: eraseOn(),
        value: { space: "12" },
      })).subject,
    );

  class Offers {
    async reads(request) {
      return {
        nonResidents: await outcome(() => host.addressBook.nonResidents()),
        caller: (await host.addressBook.caller(request)).kind,
      };
    }
    async own(request, key) {
      const caller = await host.addressBook.caller(request);
      const subject =
        caller.kind === "listed" ? caller.resident.personId : caller.person.personId;
      return await assign(key, subject);
    }
    async other(key, subject) {
      return await assign(key, subject);
    }
  }
  Controller("offers")(Offers);
  route(Offers, Get("reads"), "reads", [Req()]);
  route(Offers, Get("own"), "own", [Req(), Query("key")]);
  route(Offers, Get("other"), "other", [Query("key"), Query("subject")]);

  class Board {
    async assign(body) {
      return await assign(body.key, body.subject);
    }
    async audit(request, body) {
      return await outcome(async () => {
        await host.audit.record(request, { event: "space.assigned", subject: body.subject });
        return "recorded";
      });
    }
    async nonResidents() {
      return await outcome(() => host.addressBook.nonResidents());
    }
    async mail(body) {
      const person = (await host.addressBook.nonResidents()).find(
        (candidate) => candidate.personId === body.personId,
      );
      await host.mail.send({ to: person.email, subject: "Plats", text: "Du har fått plats 12." });
      return { sent: person.email };
    }
  }
  Controller("board")(Board);
  route(Board, Post("assign"), "assign", [Body()]);
  route(Board, Post("audit"), "audit", [Req(), Body()]);
  route(Board, Get("non-residents"), "nonResidents");
  route(Board, Post("mail"), "mail", [Body()]);

  class RecordsModule {}
  Module({ controllers: [Offers, Board] })(RecordsModule);
  return { module: RecordsModule };
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
  method: "GET" | "POST" | "PATCH";
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

/** The board's grant or withdrawal of a plugin access, on the person's page. */
function setAccess(personId: string, pluginId: string, granted: boolean) {
  return inject({
    method: "PATCH",
    url: `/api/plugin-accesses/persons/${personId}`,
    payload: { pluginId, granted },
    headers: { cookie: cookies[standingId("board")] ?? "" },
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
    const records = pluginId === RECORDS;
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: `openbrf-plugin-${pluginId}`,
        version: "1.0.0",
        openbrf: {
          apiVersion: 1,
          id: pluginId,
          entry: { server: "./dist/server.cjs" },
          permissions: records ? RECORDS_PERMISSIONS : ["addressBook:read"],
          personalData: records ? ["name", "email"] : ["name"],
          ...(records ? { personRecords: [ASSIGNMENTS] } : {}),
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
    await writeFile(
      join(directory, "dist", "server.cjs"),
      records ? RECORDS_BUNDLE : BUNDLE,
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
        permissions:
          pluginId === RECORDS ? RECORDS_PERMISSIONS : ["addressBook:read"],
        personalData: pluginId === RECORDS ? ["name", "email"] : ["name"],
        ...(pluginId === RECORDS ? { personRecords: [ASSIGNMENTS] } : {}),
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
      residency(persons.formerGranted, LONG_AGO, MOVED_OUT),
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
      seat(persons.leavingBoard),
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

  // Written directly: the grant refuses the former resident and the plugins
  // that do not serve the class, and the suite tests what the guard does with
  // such a row all the same.
  await prisma.pluginAccess.createMany({
    data: [
      ...[undefined, ...REFUSALS].map((refusal) => ({
        personId: standingId("granted", refusal),
        pluginId: SERVING,
      })),
      { personId: persons.formerGranted, pluginId: SERVING },
      ...[ONLY_ACCESS, RESIDENTS, NARROWER].map((pluginId) => ({
        personId: persons.grantedElsewhere,
        pluginId,
      })),
      { personId: persons.withdrawn, pluginId: SERVING },
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
      await prisma.pluginRecord.deleteMany({ where: { pluginId: RECORDS } });
      await prisma.pluginAccess.deleteMany({
        where: { personId: { in: ACCOUNTS } },
      });
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: PLUGINS } },
      });
      // Audit entries stay: the table is append-only.
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
    ["a former resident who holds an access", persons.formerGranted],
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
      persons.formerGranted,
      persons.grantedElsewhere,
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
        SERVING,
        persons.movingOutToday,
        classes,
        noon(addLocalDays(today, -1)),
      ),
    ).toBe(true);
    expect(
      await addressBook.isOffered(
        SERVING,
        persons.movingOutToday,
        classes,
        noon(today),
      ),
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

describe("a plugin access", () => {
  it("serves a person only on the plugin the access was granted to", async () => {
    const before = await ran(SERVING);

    expect(
      (await get(ONLY_ACCESS, "offers/mine", persons.grantedElsewhere))
        .statusCode,
    ).toBe(200);
    expectRefused(await get(SERVING, "offers/mine", persons.grantedElsewhere));
    expectRefused(await get(ONLY_ACCESS, "offers/mine", standingId("granted")));
    expect(await ran(SERVING)).toBe(before);
  });

  it("serves nobody on a plugin that does not declare the class, nor on one that declares it without the install approving it", async () => {
    // RESIDENTS declares no class; NARROWER's install approved pluginAccess,
    // which its manifest does not declare.
    expectRefused(
      await get(RESIDENTS, "offers/mine", persons.grantedElsewhere),
    );
    expectRefused(await get(NARROWER, "offers/mine", persons.grantedElsewhere));

    // A manifest that declares a class its install did not approve is refused
    // at load, so the guard never sees it; the predicate is asked directly,
    // with the classes the host would work out.
    const addressBook = application().get(PluginAddressBookService);
    const approved = EVERY_CLASS.filter((caller) => caller !== "pluginAccess");
    expect(
      await addressBook.isServed(SERVING, standingId("granted"), approved),
    ).toBe(false);
    expect(
      await addressBook.isOffered(SERVING, standingId("granted"), approved),
    ).toBe(false);
    expect(
      await addressBook.isServed(SERVING, standingId("granted"), EVERY_CLASS),
    ).toBe(true);
  });

  it("refuses the person on their next request once the board withdraws it", async () => {
    expect(
      (await get(SERVING, "offers/mine", persons.withdrawn)).statusCode,
    ).toBe(200);

    const response = await setAccess(persons.withdrawn, SERVING, false);
    expect(response.statusCode, response.body).toBe(200);

    const before = await ran(SERVING);
    expectRefused(await get(SERVING, "offers/mine", persons.withdrawn));
    expect(await ran(SERVING)).toBe(before);
  });
});

describe("the board's grant of a plugin access", () => {
  it("offers the loaded plugins that declare the class and whose install approved it", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugin-accesses/plugins",
      headers: { cookie: cookies[standingId("board")] ?? "" },
    });

    expect(response.statusCode, response.body).toBe(200);
    const offered = response
      .json<{ plugins: { pluginId: string }[] }>()
      .plugins.map((plugin) => plugin.pluginId)
      .filter((pluginId) => PLUGINS.includes(pluginId))
      .sort();
    expect(offered).toEqual([ONLY_ACCESS, RECORDS, SERVING].sort());
  });

  it.each([
    ["declares no class", RESIDENTS],
    ["declares the board, though its install approved the class", NARROWER],
    ["was refused at load", WIDENED],
    ["offers its view to everybody signed in", SIGNED_IN],
  ])("refuses a grant to a plugin that %s", async (_, pluginId) => {
    const response = await setAccess(persons.candidate, pluginId, true);

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "plugin-access-not-served",
    );
    expect(
      await prisma.pluginAccess.count({
        where: { personId: persons.candidate },
      }),
    ).toBe(0);
  });

  it("grants an access to a plugin that serves the class, and the person is served on their next request", async () => {
    expectRefused(await get(ONLY_ACCESS, "offers/mine", persons.candidate));

    const response = await setAccess(persons.candidate, ONLY_ACCESS, true);
    expect(response.statusCode, response.body).toBe(200);

    expect(
      (await get(ONLY_ACCESS, "offers/mine", persons.candidate)).statusCode,
    ).toBe(200);
    expectRefused(await get(SERVING, "offers/mine", persons.candidate));
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
      standingId("granted"),
      persons.movingInBoard,
    ]) {
      expect(await sectionOf(SERVING, personId)).toBe("building");
    }
    expect(await sectionOf(ONLY_ACCESS, persons.grantedElsewhere)).toBe(
      "building",
    );
  });

  it("does not read the three refusals, so a withheld person in a class is offered it", async () => {
    for (const refusal of REFUSALS) {
      for (const standing of ["manager", "granted"] as const) {
        expect(await sectionOf(SERVING, standingId(standing, refusal))).toBe(
          "building",
        );
      }
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
      persons.formerGranted,
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

  it("does not offer it through an access to another plugin, nor to one that does not declare the class", async () => {
    expect(await sectionOf(SERVING, persons.grantedElsewhere)).toBeNull();
    expect(await sectionOf(ONLY_ACCESS, standingId("granted"))).toBeNull();
    expect(await sectionOf(RESIDENTS, persons.grantedElsewhere)).toBeNull();
    expect(await sectionOf(NARROWER, persons.grantedElsewhere)).toBeNull();
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

/** A POST to a plugin's route, as the person signed in with `cookie`. */
function post(pluginId: string, path: string, personId: string, body: object) {
  return inject({
    method: "POST",
    url: `/api/plugin/${pluginId}/${path}`,
    payload: body,
    headers: { cookie: cookies[personId] ?? "" },
  });
}

/** The board's assignment of a space, written on `RECORDS`'s board route. */
async function assign(key: string, subject: string): Promise<unknown> {
  const response = await post(RECORDS, "board/assign", persons.reader, {
    key,
    subject,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

/** An audit entry about a person, recorded on `RECORDS`'s board route. */
async function audit(subject: string): Promise<unknown> {
  const response = await post(RECORDS, "board/audit", persons.reader, {
    subject,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

/** This run's persons in what `nonResidents()` answered, in its order. */
function ofThisRun(answer: unknown): string[] {
  const listed = (answer as { answered: { personId: string }[] }).answered;
  return listed
    .map((person) => person.personId)
    .filter((personId) => ACCOUNTS.includes(personId));
}

describe("a record about a person off a resident route (ADR 0047, as ADR 0053 amends it)", () => {
  it.each([
    ["a board member who lives elsewhere", standingId("board")],
    ["an administrator who lives elsewhere", standingId("administrator")],
    ["the property manager", standingId("manager")],
    [
      "a person who moves in tomorrow and holds a board seat",
      persons.movingInBoard,
    ],
    ["a resident", standingId("resident")],
  ])("is accepted about %s, as is an audit entry", async (_, subject) => {
    expect(await assign(`space-${subject}`, subject)).toEqual({
      answered: subject,
    });
    expect(await audit(subject)).toEqual({ answered: "recorded" });
  });

  it("is refused alike about a person in no class, a withheld person, a former resident and an id nobody has", async () => {
    const refused = [
      persons.nobody,
      standingId("manager", "protected"),
      standingId("board", "restricted"),
      persons.formerBoard,
      persons.endedSeat,
      id("unknown"),
    ];
    const records = await Promise.all(
      refused.map((subject) => assign(`refused-${subject}`, subject)),
    );
    const entries = await Promise.all(refused.map((subject) => audit(subject)));

    // One answer for all of them, which says nothing about why.
    for (const answer of [...records, ...entries]) {
      expect(answer).toEqual({ refused: "PluginRecordSubjectError" });
    }
    expect(
      await prisma.pluginRecord.count({
        where: { pluginId: RECORDS, subjectPersonId: { in: refused } },
      }),
    ).toBe(0);
  });

  it("is rewritten about its subject after they leave the class, and no new one names them", async () => {
    const subject = persons.leavingBoard;
    expect(await assign("space-leaving", subject)).toEqual({
      answered: subject,
    });

    await prisma.boardPosition.updateMany({
      where: { personId: subject },
      data: { endedOn: dateColumnOf(addLocalDays(today, -1)) },
    });

    expect(await assign("space-leaving", subject)).toEqual({
      answered: subject,
    });
    expect(await assign("space-leaving-again", subject)).toEqual({
      refused: "PluginRecordSubjectError",
    });
  });
});

describe("host.addressBook.nonResidents()", () => {
  it("lists the persons served in a class who hold no residency today, and nobody withheld", async () => {
    const response = await get(RECORDS, "board/non-residents", persons.reader);
    expect(response.statusCode).toBe(200);
    const listed = ofThisRun(response.json());

    const IN_A_CLASS = ["board", "administrator", "manager"] as const;
    expect(new Set(listed)).toEqual(
      new Set([
        ...IN_A_CLASS.map((standing) => standingId(standing)),
        // Their objection is to `SERVING`'s processing, not to this plugin's.
        ...IN_A_CLASS.map((standing) => standingId(standing, "objecting")),
        persons.reader,
        persons.movingInBoard,
        // Its seat may have ended in the test above, which ran first.
        ...(listed.includes(persons.leavingBoard)
          ? [persons.leavingBoard]
          : []),
      ]),
    );
    for (const absent of [
      standingId("resident"),
      ...STANDINGS.flatMap((standing) =>
        (["protected", "restricted"] as const).map((refusal) =>
          standingId(standing, refusal),
        ),
      ),
      persons.former,
      persons.formerBoard,
      persons.formerAdmin,
      persons.formerManager,
      persons.movingOutToday,
      persons.movingIn,
      persons.endedSeat,
      persons.returning,
      persons.nobody,
    ]) {
      expect(listed).not.toContain(absent);
    }
  });

  it("leaves out a person who objects to the reading plugin's processing", async () => {
    const addressBook = application().get(PluginAddressBookService);
    const listed = (
      await addressBook.nonResidents(
        SERVING,
        await addressBook.servedClasses(SERVING, EVERY_CLASS),
        { contact: false },
      )
    ).map((person) => person.personId);

    expect(listed).toContain(standingId("board"));
    for (const standing of ["board", "administrator", "manager"] as const) {
      expect(listed).not.toContain(standingId(standing, "objecting"));
    }
  });

  it("gives a person no apartment, and contact details on the terms of residents()", async () => {
    const response = await get(RECORDS, "board/non-residents", persons.reader);
    const person = response
      .json<{ answered: Record<string, unknown>[] }>()
      .answered.find(
        (candidate) => candidate["personId"] === standingId("board"),
      );

    expect(person).toEqual({
      personId: standingId("board"),
      name: "Förnamn Efternamn",
      lastName: "Efternamn",
      email: null,
      phone: null,
    });
  });

  it("lists nobody for a plugin that declares no class, and for one that declares only the access, the persons holding an access to it", async () => {
    const addressBook = application().get(PluginAddressBookService);
    const listedFor = async (
      pluginId: string,
      declared: readonly PluginNonResidentCaller[],
    ) =>
      (
        await addressBook.nonResidents(
          pluginId,
          await addressBook.servedClasses(pluginId, declared),
          { contact: false },
        )
      )
        .map((person) => person.personId)
        .filter((personId) => ACCOUNTS.includes(personId));

    expect(await listedFor(RESIDENTS, [])).toEqual([]);

    const held = await prisma.pluginAccess.findMany({
      where: { pluginId: ONLY_ACCESS, personId: { in: ACCOUNTS } },
      select: { personId: true },
    });
    expect(held.map((access) => access.personId)).toContain(
      persons.grantedElsewhere,
    );
    expect((await listedFor(ONLY_ACCESS, ["pluginAccess"])).sort()).toEqual(
      held.map((access) => access.personId).sort(),
    );
  });

  it("is refused on a resident route, where caller answers a person in a class as nonResident", async () => {
    const response = await get(RECORDS, "offers/reads", standingId("manager"));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      nonResidents: {
        refused: "PluginResidentRouteError addressBook.nonResidents",
      },
      caller: "nonResident",
    });
    expect(
      (await get(RECORDS, "offers/reads", standingId("resident"))).json(),
    ).toMatchObject({ caller: "listed" });
  });

  it("answers caller as notListed to a plugin that serves no class, and to a former resident in one", async () => {
    const addressBook = application().get(PluginAddressBookService);
    const every = await addressBook.servedClasses(RECORDS, EVERY_CLASS);

    await expect(
      addressBook.caller(RESIDENTS, standingId("board"), [], {
        contact: false,
      }),
    ).resolves.toEqual({ kind: "notListed" });
    await expect(
      addressBook.caller(RECORDS, persons.formerBoard, every, {
        contact: false,
      }),
    ).resolves.toEqual({ kind: "notListed" });
    await expect(
      addressBook.caller(RECORDS, standingId("board"), every, {
        contact: false,
      }),
    ).resolves.toMatchObject({
      kind: "nonResident",
      person: { personId: standingId("board") },
    });
  });

  it("answers caller from one read, so a board member who moves in during it is never notListed", async () => {
    const addressBook = application().get(PluginAddressBookService);
    const every = await addressBook.servedClasses(RECORDS, EVERY_CLASS);
    const personId = id("moves-in-mid-request");

    // The residency begins as soon as the first read `caller` makes about
    // the person has answered, whichever read that is. Served before it and
    // after it, the person may be `nonResident` or `listed`, never neither.
    let movedIn = false;
    const moveInAfter = async <Rows>(read: PromiseLike<Rows>) => {
      const rows = await read;
      if (!movedIn) {
        movedIn = true;
        await prisma.residency.create({
          data: {
            personId,
            apartmentId: apartment,
            role: "RESIDENT",
            movedInOn: LONG_AGO,
          },
        });
      }
      return rows;
    };
    const reads = [
      [prisma.person, "findFirst"],
      [prisma.person, "findMany"],
      [prisma.residency, "findMany"],
    ] as const;
    try {
      await prisma.person.create({
        data: { id: personId, firstName: "Förnamn", lastName: "Efternamn" },
      });
      await prisma.boardPosition.create({
        data: { personId, position: "BOARD_MEMBER", electedOn: LONG_AGO },
      });
      let answer: Awaited<ReturnType<typeof addressBook.caller>>;
      const spies = reads.map(([delegate, method]) => {
        const original = (
          delegate[method] as (...args: unknown[]) => PromiseLike<unknown>
        ).bind(delegate);
        return vi
          .spyOn(delegate, method)
          .mockImplementation(((...args: unknown[]) =>
            moveInAfter(original(...args))) as never);
      });
      try {
        answer = await addressBook.caller(RECORDS, personId, every, {
          contact: false,
        });
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }

      expect(movedIn).toBe(true);
      expect(answer).toMatchObject({
        kind: "nonResident",
        person: { personId },
      });
      await expect(
        addressBook.caller(RECORDS, personId, every, { contact: false }),
      ).resolves.toMatchObject({ kind: "listed", resident: { personId } });
    } finally {
      await prisma.residency.deleteMany({ where: { personId } });
      await prisma.boardPosition.deleteMany({ where: { personId } });
      await prisma.person.deleteMany({ where: { id: personId } });
    }
  });
});

describe("a record on a resident route served to a person in a class", () => {
  it("names the caller, and nobody else", async () => {
    const manager = standingId("manager");

    expect(
      (await get(RECORDS, "offers/own?key=own-offer", manager)).json(),
    ).toEqual({ answered: manager });
    expect(
      (
        await get(
          RECORDS,
          `offers/other?key=other-offer&subject=${standingId("resident")}`,
          manager,
        )
      ).json(),
    ).toEqual({ refused: "PluginRecordSubjectError" });
  });
});

describe("mail to a person nonResidents() lists", () => {
  it("goes to the address it gives, under host.mail's own rules", async () => {
    const manager = standingId("manager");
    const email = `${manager}@exempel.se`;
    const cipher = await application()
      .get(FieldEncryptionService)
      .encrypt("person.email", email);
    await prisma.person.update({
      where: { id: manager },
      data: { emailCipher: cipher.cipher, emailIndex: cipher.index },
    });
    const send = vi
      .spyOn(application().get(MailService), "send")
      .mockResolvedValue(undefined as never);
    try {
      const response = await post(RECORDS, "board/mail", persons.reader, {
        personId: manager,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ sent: email });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: email }));
    } finally {
      send.mockRestore();
    }
  });
});

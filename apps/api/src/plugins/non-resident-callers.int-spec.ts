import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type {
  PluginExtensionDeclaration,
  PluginExtensionPointDeclaration,
  PluginNonResidentCaller,
  PluginPermission,
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
import { loadPlugins, type PluginBoot, readPluginRecords } from "./plugin-boot";
import { PluginHostBinding } from "./plugin-host";
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
 * to every account. `WITHDRAWING` declares the board and the property manager,
 * both approved, for the administrator to withdraw and consent to again.
 * `DROPPING` is a version that declares only the property manager, whose
 * install approved the board as well and had the property manager withdrawn.
 *
 * `FLOOR_HOST` reads the finances and offers a point, and `FLOOR_ADDON`, which
 * reads the address book, extends it. It offers its view to every account and
 * declares a resident route, and its routes hold the group's finance floor
 * (ADR 0052): an ordinary resident is offered the view and is refused its
 * handler.
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
const WITHDRAWING = `classes-withdrawing-${suffix}`;
const DROPPING = `classes-dropping-${suffix}`;
/** An install row with no package, for what a consent does to the sets. */
const CONSENTING = `classes-consenting-${suffix}`;
const FLOOR_HOST = `classes-floor-host-${suffix}`;
const FLOOR_ADDON = `classes-floor-addon-${suffix}`;
const PLUGINS = [
  SERVING,
  RESIDENTS,
  ONLY_ACCESS,
  NARROWER,
  WIDENED,
  SIGNED_IN,
  WITHDRAWING,
  DROPPING,
  FLOOR_HOST,
  FLOOR_ADDON,
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
  [WITHDRAWING]: ["board", "propertyManager"],
  [DROPPING]: ["propertyManager"],
  [FLOOR_HOST]: undefined,
  [FLOOR_ADDON]: undefined,
};
const APPROVED: Record<string, PluginNonResidentCaller[]> = {
  [SERVING]: EVERY_CLASS,
  [RESIDENTS]: [],
  [ONLY_ACCESS]: ["pluginAccess"],
  [NARROWER]: ["board", "propertyManager", "pluginAccess"],
  [WIDENED]: ["board"],
  [SIGNED_IN]: [],
  [WITHDRAWING]: ["board", "propertyManager"],
  [DROPPING]: ["board", "propertyManager"],
  [FLOOR_HOST]: [],
  [FLOOR_ADDON]: [],
};

/** What a plugin's package and its consent declare besides its routes. */
interface Declared {
  /** Whether it declares the resident route and the view. */
  serves: boolean;
  permissions: PluginPermission[];
  extensionPoints: PluginExtensionPointDeclaration[];
  extends: PluginExtensionDeclaration[];
}

const FLOOR_POINT: PluginExtensionPointDeclaration = {
  id: "source",
  version: 1,
  personalData: [],
};

/**
 * Every plugin reads the address book, but the host of the floor's group, which
 * reads the finances instead and, declaring an extension point, may declare no
 * resident route. The addon reads the address book, so its resident route is
 * the one that lowers its group's floor by that half alone.
 */
function declaredBy(pluginId: string): Declared {
  if (pluginId === FLOOR_HOST) {
    return {
      serves: false,
      permissions: ["finances:read"],
      extensionPoints: [FLOOR_POINT],
      extends: [],
    };
  }
  if (pluginId === FLOOR_ADDON) {
    return {
      serves: true,
      permissions: ["addressBook:read"],
      extensionPoints: [],
      extends: [
        {
          plugin: FLOOR_HOST,
          point: "source",
          version: 1,
          personalData: [],
        },
      ],
    };
  }
  return {
    serves: true,
    permissions: ["addressBook:read"],
    extensionPoints: [],
    extends: [],
  };
}

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

/** The host of the floor's group: it offers the point and serves nothing. */
const HOST_BUNDLE = `const { Module } = require("@nestjs/common");
const { z } = require("zod");

class HostModule {}
Module({})(HostModule);

exports.createPlugin = function createPlugin(host) {
  host.extensions.define("source", {
    input: z.strictObject({}),
    output: z.strictObject({}),
  });
  return { module: HostModule };
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
  method: "GET" | "POST" | "PUT" | "PATCH";
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

/**
 * Writes a plugin's package.json on the volume, declaring `declared` as the
 * classes of caller its resident routes serve. Version 1.0.0 always, so the
 * install's row names the version on the volume.
 */
async function writeManifest(
  dataDir: string,
  pluginId: string,
  declared: PluginNonResidentCaller[] | undefined,
): Promise<void> {
  const given = declaredBy(pluginId);
  await writeFile(
    join(
      dataPaths(dataDir).plugins,
      "node_modules",
      `openbrf-plugin-${pluginId}`,
      "package.json",
    ),
    JSON.stringify({
      name: `openbrf-plugin-${pluginId}`,
      version: "1.0.0",
      openbrf: {
        apiVersion: 1,
        id: pluginId,
        entry: { server: "./dist/server.cjs" },
        permissions: given.permissions,
        personalData: ["name"],
        extensionPoints: given.extensionPoints,
        extends: given.extends,
        ...(given.serves
          ? {
              processing: PROCESSING,
              residentRoutes: RESIDENT_ROUTES,
              ...(declared === undefined
                ? {}
                : { nonResidentCallers: declared }),
              view: {
                titleKey: "view.title",
                section: "building",
                ...([SIGNED_IN, FLOOR_ADDON].includes(pluginId)
                  ? { offeredTo: "signedIn" }
                  : {}),
              },
            }
          : {}),
      },
    }),
    "utf8",
  );
}

/** The environment the application was started with. */
let pluginEnv: Env | undefined;

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
    await writeManifest(created, pluginId, DECLARED[pluginId]);
    await writeFile(
      join(directory, "dist", "server.cjs"),
      pluginId === FLOOR_HOST ? HOST_BUNDLE : BUNDLE,
      "utf8",
    );
  }

  const env: Env = {
    ...baseEnv,
    OPENBRF_DATA_DIR: created,
    OPENBRF_PLUGINS_ENABLED: true,
  };
  pluginEnv = env;
  const bootstrapPrisma = new PrismaService(env);
  await bootstrapPrisma.$connect();
  try {
    const registry = new PluginRegistryService(bootstrapPrisma);
    for (const pluginId of PLUGINS) {
      await bootstrapPrisma.installedPlugin.deleteMany({
        where: { id: pluginId },
      });
      const given = declaredBy(pluginId);
      await registry.consent({
        id: pluginId,
        packageName: `openbrf-plugin-${pluginId}`,
        version: "1.0.0",
        tarballUrl: `file:///dev/null/${pluginId}.tgz`,
        checksum: "sha512-unused-in-this-suite",
        permissions: given.permissions,
        personalData: ["name"],
        extensionPoints: given.extensionPoints,
        extends: given.extends,
        actions: [],
        recipients: [],
        deviceRoutes: [],
        residentRoutes: given.serves ? RESIDENT_ROUTES : [],
        nonResidentCallers: given.serves ? (APPROVED[pluginId] ?? []) : [],
        ai: false,
        licence: null,
      });
    }
    // Withdrawn before the version that drops the board loads.
    await registry.setNonResidentCallerWithdrawn(
      DROPPING,
      "propertyManager",
      true,
    );
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
      await prisma.pluginAccess.deleteMany({
        where: { personId: { in: ACCOUNTS } },
      });
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: [...PLUGINS, CONSENTING] } },
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
    expect(offered).toEqual([ONLY_ACCESS, SERVING].sort());
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

  it("offers a view under a group's finance floor to an ordinary resident, while its handler is refused and never runs", async () => {
    const resident = standingId("resident");
    const before = await ran(FLOOR_ADDON);

    expect(
      application().get(PluginLoaderService).get(FLOOR_ADDON)?.routeFloor,
    ).toEqual(["addressBook:read", "fees:manage", "memberCharges:manage"]);
    expect(await sectionOf(FLOOR_ADDON, resident)).toBe("building");

    const refused = await get(FLOOR_ADDON, "offers/mine", resident);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).not.toMatchObject({
      reason: "resident-route-not-listed",
    });
    expect(await ran(FLOOR_ADDON)).toBe(before);
  });
});

describe("withdrawing one class of caller (ADR 0053)", () => {
  const ACTOR_NAME = "Förnamn Efternamn";
  type PluginConsentActShape = {
    by: string | null;
    protectedActor: boolean;
    at: string;
  };

  /** The administrator's withdrawal or consent again, on the plugin's page. */
  function setWithdrawn(
    pluginId: string,
    caller: string,
    withdrawn: boolean,
    personId: string = persons.reader,
  ) {
    return inject({
      method: "PUT",
      url: `/api/plugins/${pluginId}/non-resident-callers/${caller}`,
      payload: { withdrawn },
      headers: { cookie: cookies[personId] ?? "" },
    });
  }

  async function sets(pluginId: string) {
    return prisma.installedPlugin.findUniqueOrThrow({
      where: { id: pluginId },
      select: {
        consentedNonResidentCallers: true,
        withdrawnNonResidentCallers: true,
      },
    });
  }

  async function entries(
    pluginId: string,
    action:
      | "PLUGIN_NON_RESIDENT_CALLER_WITHDRAWN"
      | "PLUGIN_NON_RESIDENT_CALLER_CONSENTED",
  ) {
    return prisma.auditLogEntry.findMany({
      where: { targetKind: "plugin", targetId: pluginId, action },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * What a restart does with the install's row as it stands: the boot gate
   * over the package on the volume, and then, for a version that loaded, the
   * loader's cut of the classes it no longer declares.
   */
  async function reload(pluginId: string): Promise<PluginBoot> {
    if (pluginEnv === undefined) {
      throw new Error("The application was not started.");
    }
    const { records } = await readPluginRecords(pluginEnv);
    const boot = await loadPlugins({
      env: pluginEnv,
      records: records.filter((record) => record.id === pluginId),
      binding: new PluginHostBinding(),
    });
    await application().get(PluginLoaderService).onApplicationBootstrap();
    return boot;
  }

  function served(boot: PluginBoot, pluginId: string): boolean {
    return (
      boot.plugins.some((plugin) => plugin.id === pluginId) &&
      !boot.findings.some((finding) => finding.id === pluginId)
    );
  }

  it("serves nobody in a withdrawn class from the next request, keeps the plugin, and records who withdrew it", async () => {
    expect(
      (await get(WITHDRAWING, "offers/mine", standingId("manager"))).statusCode,
    ).toBe(200);

    const response = await setWithdrawn(WITHDRAWING, "propertyManager", true);
    expect(response.statusCode, response.body).toBe(200);

    expectRefused(await get(WITHDRAWING, "offers/mine", standingId("manager")));
    expect(
      (await get(WITHDRAWING, "offers/mine", standingId("board"))).statusCode,
    ).toBe(200);
    expect(application().get(PluginLoaderService).get(WITHDRAWING)).not.toBe(
      null,
    );
    expect(await sets(WITHDRAWING)).toEqual({
      consentedNonResidentCallers: ["board", "propertyManager"],
      withdrawnNonResidentCallers: ["propertyManager"],
    });

    const withdrawals = await entries(
      WITHDRAWING,
      "PLUGIN_NON_RESIDENT_CALLER_WITHDRAWN",
    );
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]).toMatchObject({
      actorPersonId: persons.reader,
      channel: "WEB",
      context: { nonResidentCaller: "propertyManager" },
    });

    // Asked again, nothing changes and nothing more is recorded.
    expect(
      (await setWithdrawn(WITHDRAWING, "propertyManager", true)).statusCode,
    ).toBe(200);
    expect(
      await entries(WITHDRAWING, "PLUGIN_NON_RESIDENT_CALLER_WITHDRAWN"),
    ).toHaveLength(1);
  });

  it("keeps the class withdrawn through a reload of the same version, which is not refused as widened", async () => {
    const boot = await reload(WITHDRAWING);

    expect(served(boot, WITHDRAWING)).toBe(true);
    expect(await sets(WITHDRAWING)).toEqual({
      consentedNonResidentCallers: ["board", "propertyManager"],
      withdrawnNonResidentCallers: ["propertyManager"],
    });
    expectRefused(await get(WITHDRAWING, "offers/mine", standingId("manager")));
    expect(
      (await get(WITHDRAWING, "offers/mine", standingId("board"))).statusCode,
    ).toBe(200);
  });

  it("serves a class consented to again from the next request, and a reload keeps it served", async () => {
    const response = await setWithdrawn(WITHDRAWING, "propertyManager", false);
    expect(response.statusCode, response.body).toBe(200);

    expect(
      (await get(WITHDRAWING, "offers/mine", standingId("manager"))).statusCode,
    ).toBe(200);
    const consents = await entries(
      WITHDRAWING,
      "PLUGIN_NON_RESIDENT_CALLER_CONSENTED",
    );
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      actorPersonId: persons.reader,
      channel: "WEB",
      context: { nonResidentCaller: "propertyManager" },
    });

    expect(served(await reload(WITHDRAWING), WITHDRAWING)).toBe(true);
    expect((await sets(WITHDRAWING)).withdrawnNonResidentCallers).toEqual([]);
    expect(
      (await get(WITHDRAWING, "offers/mine", standingId("manager"))).statusCode,
    ).toBe(200);
  });

  it("shows the board which classes the install serves, and who consented to and withdrew each", async () => {
    expect(
      (await setWithdrawn(WITHDRAWING, "propertyManager", true)).statusCode,
    ).toBe(200);

    // The board reads it, at association:read.
    const response = await inject({
      method: "GET",
      url: "/api/plugins",
      headers: { cookie: cookies[standingId("board")] ?? "" },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plugin = response
      .json<{
        plugins: {
          id: string;
          nonResidentCallers: {
            caller: string;
            withdrawn: boolean;
            consented: PluginConsentActShape | null;
            withdrawnBy: PluginConsentActShape | null;
          }[];
        }[];
      }>()
      .plugins.find((candidate) => candidate.id === WITHDRAWING);

    expect(plugin?.nonResidentCallers).toEqual([
      // Approved by a consent written straight to the registry, with no
      // entry in the log to name anybody.
      { caller: "board", withdrawn: false, consented: null, withdrawnBy: null },
      {
        caller: "propertyManager",
        withdrawn: true,
        consented: {
          by: ACTOR_NAME,
          protectedActor: false,
          at: expect.any(String),
        },
        withdrawnBy: {
          by: ACTOR_NAME,
          protectedActor: false,
          at: expect.any(String),
        },
      },
    ]);
  });

  it("names no protected person on the plugins page, whether they were protected at the act or became so after it", async () => {
    async function read(reader: string) {
      const response = await inject({
        method: "GET",
        url: "/api/plugins",
        headers: { cookie: cookies[reader] ?? "" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const plugin = response
        .json<{
          plugins: {
            id: string;
            nonResidentCallers: {
              caller: string;
              consented: unknown;
              withdrawnBy: unknown;
            }[];
          }[];
        }>()
        .plugins.find((candidate) => candidate.id === WITHDRAWING);
      return {
        manager: plugin?.nonResidentCallers.find(
          (candidate) => candidate.caller === "propertyManager",
        ),
      };
    }
    const protectedAdministrator = standingId("administrator", "protected");

    // Withdrawn and consented to again by an administrator with protected
    // personal data: the board's reader is told that, and not who.
    expect(
      (await setWithdrawn(WITHDRAWING, "propertyManager", false)).statusCode,
    ).toBe(200);
    expect(
      (
        await setWithdrawn(
          WITHDRAWING,
          "propertyManager",
          true,
          protectedAdministrator,
        )
      ).statusCode,
    ).toBe(200);
    const atTheAct = await read(standingId("board"));
    expect(atTheAct.manager?.withdrawnBy).toEqual({
      by: null,
      protectedActor: true,
      at: expect.any(String),
    });

    expect(
      (
        await setWithdrawn(
          WITHDRAWING,
          "propertyManager",
          false,
          protectedAdministrator,
        )
      ).statusCode,
    ).toBe(200);
    expect((await read(standingId("board"))).manager?.consented).toEqual({
      by: null,
      protectedActor: true,
      at: expect.any(String),
    });

    // An actor who becomes protected afterwards is masked too: names are
    // resolved on every read.
    expect(
      (await setWithdrawn(WITHDRAWING, "propertyManager", true)).statusCode,
    ).toBe(200);
    expect((await read(standingId("board"))).manager?.withdrawnBy).toEqual({
      by: ACTOR_NAME,
      protectedActor: false,
      at: expect.any(String),
    });
    await prisma.person.update({
      where: { id: persons.reader },
      data: { protectedPersonalData: true },
    });
    try {
      const later = await read(standingId("board"));
      expect(later.manager?.withdrawnBy).toEqual({
        by: null,
        protectedActor: true,
        at: expect.any(String),
      });
      expect(JSON.stringify(later.manager)).not.toContain(ACTOR_NAME);
    } finally {
      await prisma.person.update({
        where: { id: persons.reader },
        data: { protectedPersonalData: false },
      });
    }
  });

  it("refuses a class the install did not approve, whether this build knows it or not, and a caller who may not manage plugins", async () => {
    expect(
      (await setWithdrawn(WITHDRAWING, "administrator", true)).statusCode,
    ).toBe(404);
    expect(
      (await setWithdrawn(WITHDRAWING, "everybody", true)).statusCode,
    ).toBe(404);
    expect(
      (
        await setWithdrawn(
          WITHDRAWING,
          "propertyManager",
          false,
          standingId("board"),
        )
      ).statusCode,
    ).toBe(403);
    expect((await sets(WITHDRAWING)).withdrawnNonResidentCallers).toEqual([
      "propertyManager",
    ]);
  });

  it("cuts both sets to a version that drops a class, and refuses a later version that declares it again as widened", async () => {
    // At start the version declaring only the property manager loaded and
    // dropped the board from the approved set; the property manager stays
    // withdrawn, so the plugin serves nobody in either class.
    expect(await sets(DROPPING)).toEqual({
      consentedNonResidentCallers: ["propertyManager"],
      withdrawnNonResidentCallers: ["propertyManager"],
    });
    expectRefused(await get(DROPPING, "offers/mine", standingId("board")));
    expectRefused(await get(DROPPING, "offers/mine", standingId("manager")));
    expect(
      (await get(DROPPING, "offers/mine", standingId("resident"))).statusCode,
    ).toBe(200);
    // And so did the one whose install approved a class it never declared.
    expect((await sets(NARROWER)).consentedNonResidentCallers).toEqual([
      "board",
    ]);

    if (workspace === undefined) {
      throw new Error("The application was not started.");
    }
    await writeManifest(workspace, DROPPING, ["board", "propertyManager"]);
    try {
      const boot = await reload(DROPPING);
      expect(boot.plugins.some((plugin) => plugin.id === DROPPING)).toBe(false);
      expect(
        boot.findings.find((finding) => finding.id === DROPPING),
      ).toMatchObject({
        reason: "resident-routes-widened",
        detail: { nonResidentCallers: ["board"] },
      });
      expect(await sets(DROPPING)).toEqual({
        consentedNonResidentCallers: ["propertyManager"],
        withdrawnNonResidentCallers: ["propertyManager"],
      });
    } finally {
      await writeManifest(workspace, DROPPING, DECLARED[DROPPING]);
    }
  });

  it("keeps a withdrawn class withdrawn through a consent to a new version that declares it, and drops it with one that does not", async () => {
    const registry = application().get(PluginRegistryService);
    const consent = (version: string, classes: PluginNonResidentCaller[]) =>
      registry.consent({
        id: CONSENTING,
        packageName: `openbrf-plugin-${CONSENTING}`,
        version,
        tarballUrl: `file:///dev/null/${CONSENTING}.tgz`,
        checksum: "sha512-unused-in-this-suite",
        permissions: ["addressBook:read"],
        personalData: ["name"],
        actions: [],
        recipients: [],
        deviceRoutes: [],
        residentRoutes: RESIDENT_ROUTES,
        nonResidentCallers: classes,
        ai: false,
        licence: null,
      });

    await consent("1.0.0", ["board", "propertyManager"]);
    expect(
      await registry.setNonResidentCallerWithdrawn(
        CONSENTING,
        "propertyManager",
        true,
      ),
    ).toBe(true);

    const kept = await consent("1.0.1", ["board", "propertyManager"]);
    expect(kept.consentedNonResidentCallers).toEqual([
      "board",
      "propertyManager",
    ]);
    expect(kept.withdrawnNonResidentCallers).toEqual(["propertyManager"]);

    const dropped = await consent("1.0.2", ["board"]);
    expect(dropped.consentedNonResidentCallers).toEqual(["board"]);
    expect(dropped.withdrawnNonResidentCallers).toEqual([]);

    // Declared again, it is approved by that consent and served.
    const again = await consent("1.0.3", ["board", "propertyManager"]);
    expect(again.withdrawnNonResidentCallers).toEqual([]);
  });

  it("lets the administrator withdraw and restore an approved class this build does not know", async () => {
    const before = await sets(CONSENTING);
    const unknown = "futureClass";
    await prisma.installedPlugin.update({
      where: { id: CONSENTING },
      data: {
        consentedNonResidentCallers: [
          ...before.consentedNonResidentCallers,
          unknown,
        ],
      },
    });
    try {
      const withdrawn = await setWithdrawn(CONSENTING, unknown, true);
      expect(withdrawn.statusCode, withdrawn.body).toBe(200);
      expect((await sets(CONSENTING)).withdrawnNonResidentCallers).toContain(
        unknown,
      );

      const restored = await setWithdrawn(CONSENTING, unknown, false);
      expect(restored.statusCode, restored.body).toBe(200);
      expect(
        (await sets(CONSENTING)).withdrawnNonResidentCallers,
      ).not.toContain(unknown);

      // A class the install never approved is still not found.
      expect(
        (await setWithdrawn(CONSENTING, "neverApproved", true)).statusCode,
      ).toBe(404);
    } finally {
      await prisma.installedPlugin.update({
        where: { id: CONSENTING },
        data: {
          consentedNonResidentCallers: before.consentedNonResidentCallers,
          withdrawnNonResidentCallers: before.withdrawnNonResidentCallers,
        },
      });
    }
  });
});

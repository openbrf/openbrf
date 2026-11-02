import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type {
  PluginNonResidentCaller,
  PluginPersonRecord,
  PluginPersonRecordCollection,
  PluginProcessing,
} from "@openbrf/plugin-sdk";
import {
  addLocalDays,
  dateColumnOf,
  formatLocalDay,
  instantAt,
  localDayOf,
} from "@openbrf/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { ProcessingActivityService } from "../data-protection/processing-activity.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { dataPaths } from "../packaging/data-paths";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * A name shown at its subject's own choice (ADR 0053), through the real boot,
 * the real router, the application's guard and a real database.
 *
 * `PLUGIN` declares `ads`, a collection with `showsSubject`, and `notes`, one
 * without, and serves the board, the administrator and the property manager
 * besides its residents. Its resident route and its board route both list and
 * write records as the request's query says, and a board route hands a write to
 * a timer the plugin started at boot, which is how a job runs: outside every
 * request. The test plugin stores no name anywhere: every value is
 * `{ note: "plats" }`, so a name in an answer can only have come from the host.
 *
 * Every person has a first and a last name of their own, so an answer can be
 * searched for any part of a name that should not be in it.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
const PLUGIN = `shown-${suffix}`;
const PASSWORD = "integration-password-1";

const SERVED: PluginNonResidentCaller[] = [
  "board",
  "administrator",
  "propertyManager",
];

const ADS: PluginPersonRecordCollection = {
  collection: "ads",
  titleKey: "records.ads.title",
  personalData: ["name"],
  keepAtMostDays: 365,
  fields: [],
  showsSubject: true,
};
const NOTES: PluginPersonRecordCollection = {
  collection: "notes",
  titleKey: "records.notes.title",
  personalData: ["name"],
  keepAtMostDays: 365,
  fields: [],
};
const PERSON_RECORDS = [ADS, NOTES];

const PROCESSING: PluginProcessing = {
  purpose: {
    sv: "Låta grannar efterlysa parkeringsplatser.",
    en: "Let neighbours ask for parking spaces.",
  },
  legalBasis: "contract",
  retention: { sv: "Ett år.", en: "One year." },
  dataSubjects: ["residents"],
};

const RESIDENT_ROUTES = [{ path: "ads", titleKey: "residentRoutes.ads" }];

const id = (name: string) => `shown-${name}-${suffix}`;

const address = id("address");
const apartments = { a: id("apartment-a"), b: id("apartment-b") };

const persons = {
  /** A resident: the neighbour who reads and rewrites other people's ads. */
  a: id("a"),
  /** A resident: the subject who chooses. */
  b: id("b"),
  /** A resident: the third person a board route gives a record to. */
  c: id("c"),
  /** A resident with the administrator role: a board route's own subject. */
  boardResident: id("board-resident"),
  /** The administrator role, no residency: the board route's caller. */
  reader: id("reader"),
  /** A board seat, no residency. */
  seat: id("seat"),
  /** The property manager role, no residency. */
  manager: id("manager"),
  /** Subjects whose being served each test ends. */
  mover: id("mover"),
  endingSeat: id("ending-seat"),
  losingAdmin: id("losing-admin"),
  withdrawnManager: id("withdrawn-manager"),
  formerBoard: id("former-board"),
  turnsProtected: id("turns-protected"),
  /** A resident whose move-out lands while a read is under way. */
  movingDuringRead: id("moving-during-read"),
};
const ACCOUNTS = Object.values(persons);
const SIGNED_IN = [
  persons.a,
  persons.b,
  persons.boardResident,
  persons.reader,
  persons.seat,
  persons.manager,
];

/** Each person's own first and last name. */
const firstName = (personId: string) =>
  `Fn${personId.replaceAll("-", "")}`.slice(0, 60);
const lastName = (personId: string) =>
  `Ln${personId.replaceAll("-", "")}`.slice(0, 60);
const nameOf = (personId: string) =>
  `${firstName(personId)} ${lastName(personId)}`;

/**
 * The plugin: a resident route and a board route that list and write records,
 * and a board route that hands a write to a job.
 */
const BUNDLE = `const { Controller, Get, Module, Param, Query } = require("@nestjs/common");

exports.createPlugin = function createPlugin(host) {
  const route = (target, decorator, name, params = []) => {
    decorator(target.prototype, name, Object.getOwnPropertyDescriptor(target.prototype, name));
    params.forEach((param, index) => param(target.prototype, name, index));
  };
  const outcome = async (work) => {
    try {
      return { result: await work() };
    } catch (cause) {
      return { error: cause.name };
    }
  };
  const write = (key, query) =>
    host.personRecords.put(query.collection || "ads", key, {
      subject: query.subject,
      eraseOn: query.eraseOn,
      value: { note: "plats" },
      ...(query.show === undefined ? {} : { showSubject: query.show === "true" }),
    });
  const list = (query) => host.personRecords.list(query.collection || "ads");
  const read = (key) => host.personRecords.get("ads", key);

  // A job: work a timer started at boot runs, outside every request.
  const jobs = [];
  const ticker = setInterval(() => {
    const job = jobs.shift();
    if (job !== undefined) job();
  }, 10);
  ticker.unref();

  class Ads {
    list(query) { return outcome(() => list(query)); }
    get(key) { return outcome(() => read(key)); }
    put(key, query) { return outcome(() => write(key, query)); }
  }
  Controller("ads")(Ads);
  route(Ads, Get("list"), "list", [Query()]);
  route(Ads, Get("get/:key"), "get", [Param("key")]);
  route(Ads, Get("put/:key"), "put", [Param("key"), Query()]);

  class Board {
    list(query) { return outcome(() => list(query)); }
    put(key, query) { return outcome(() => write(key, query)); }
    job(key, query) {
      return new Promise((resolve) => {
        jobs.push(() => { outcome(() => write(key, query)).then(resolve); });
      });
    }
  }
  Controller("board")(Board);
  route(Board, Get("list"), "list", [Query()]);
  route(Board, Get("put/:key"), "put", [Param("key"), Query()]);
  route(Board, Get("job/:key"), "job", [Param("key"), Query()]);

  class ShownModule {}
  Module({ controllers: [Ads, Board] })(ShownModule);
  return { module: ShownModule };
};
`;

let app: NestFastifyApplication | undefined;
let prisma: PrismaService;
let workspace: string | undefined;
let previousDataDir: string | undefined;
const cookies: Record<string, string> = {};

function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  // 10.157.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.157.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
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

const today = localDayOf(new Date());
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
const ERASE_ON = formatLocalDay(addLocalDays(today, 60));

/** A route of the plugin's, as the person signed in with their cookie. */
async function call(
  personId: string,
  path: string,
  query: Record<string, string> = {},
): Promise<{ status: number; body: string; json: unknown }> {
  const search = new URLSearchParams(query).toString();
  const response = await inject({
    method: "GET",
    url: `/api/plugin/${PLUGIN}/${path}${search === "" ? "" : `?${search}`}`,
    headers: { cookie: cookies[personId] ?? "" },
  });
  return {
    status: response.statusCode,
    body: response.body,
    json: response.json<unknown>(),
  };
}

interface Outcome<T> {
  result?: T;
  error?: string;
}

/** A write on the resident route, as `personId`. */
async function residentPut(
  personId: string,
  key: string,
  subject: string,
  show?: boolean,
  collection = "ads",
): Promise<Outcome<PluginPersonRecord>> {
  const answer = await call(personId, `ads/put/${key}`, {
    subject,
    eraseOn: ERASE_ON,
    collection,
    ...(show === undefined ? {} : { show: String(show) }),
  });
  expect(answer.status).toBe(200);
  return answer.json as Outcome<PluginPersonRecord>;
}

/** A write on the board route, as `personId`, or handed to a job by them. */
async function boardPut(
  personId: string,
  key: string,
  subject: string,
  show?: boolean,
  via: "put" | "job" = "put",
): Promise<Outcome<PluginPersonRecord>> {
  const answer = await call(personId, `board/${via}/${key}`, {
    subject,
    eraseOn: ERASE_ON,
    ...(show === undefined ? {} : { show: String(show) }),
  });
  expect(answer.status).toBe(200);
  return answer.json as Outcome<PluginPersonRecord>;
}

/** The ads collection as `personId` reads it on the resident route. */
async function listAs(
  personId: string,
): Promise<{ records: PluginPersonRecord[]; body: string }> {
  const answer = await call(personId, "ads/list");
  expect(answer.status).toBe(200);
  const { result } = answer.json as Outcome<PluginPersonRecord[]>;
  return { records: result ?? [], body: answer.body };
}

/** One record of the ads collection as `personId` reads it, and the answer. */
async function readAs(
  personId: string,
  key: string,
): Promise<{ record: PluginPersonRecord | undefined; body: string }> {
  const { records, body } = await listAs(personId);
  return { record: records.find((record) => record.key === key), body };
}

/** The stored flag, as the database holds it. */
async function storedFlag(key: string): Promise<boolean | undefined> {
  const row = await prisma.pluginRecord.findFirst({
    where: { pluginId: PLUGIN, key, setAsideAt: null },
    select: { showSubject: true },
  });
  return row?.showSubject;
}

/**
 * A ticked record about a person the subject rule does not accept as a new
 * subject on a route yet (one served in a class, or a former resident),
 * written as the host would have stored it.
 */
async function tickedRecord(key: string, subject: string): Promise<void> {
  await prisma.pluginRecord.create({
    data: {
      pluginId: PLUGIN,
      collection: "ads",
      key,
      subjectPersonId: subject,
      eraseOn: dateColumnOf(addLocalDays(today, 60)),
      value: { note: "plats" },
      size: 16,
      showSubject: true,
    },
  });
}

/**
 * Asserts that no part of a person's name is anywhere in an answer, and,
 * given the record, that nothing of an apartment is in it. Names are each
 * person's own, so the whole answer is searched; apartments are shared, and
 * other records in the list may show them, so only the record is.
 */
function expectNothingOf(
  body: string,
  personId: string,
  record?: PluginPersonRecord,
  apartmentId?: string,
) {
  expect(body).not.toContain(firstName(personId));
  expect(body).not.toContain(lastName(personId));
  if (record !== undefined) {
    const own = JSON.stringify(record);
    expect(own).not.toContain(firstName(personId));
    expect(own).not.toContain(lastName(personId));
    expect(own).not.toContain('"apartment"');
    if (apartmentId !== undefined) {
      expect(own).not.toContain(apartmentId);
    }
  }
}

beforeAll(async () => {
  const created = await mkdtemp(join(tmpdir(), "openbrf-shown-"));
  workspace = created;
  const directory = join(
    dataPaths(created).plugins,
    "node_modules",
    `openbrf-plugin-${PLUGIN}`,
  );
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
        permissions: ["addressBook:read"],
        personalData: ["name"],
        processing: PROCESSING,
        personRecords: PERSON_RECORDS,
        residentRoutes: RESIDENT_ROUTES,
        nonResidentCallers: SERVED,
        view: { titleKey: "view.title", section: "building" },
      },
    }),
    "utf8",
  );
  await writeFile(join(directory, "dist", "server.cjs"), BUNDLE, "utf8");

  const env: Env = {
    ...baseEnv,
    OPENBRF_DATA_DIR: created,
    OPENBRF_PLUGINS_ENABLED: true,
  };
  const bootstrapPrisma = new PrismaService(env);
  await bootstrapPrisma.$connect();
  try {
    await bootstrapPrisma.installedPlugin.deleteMany({ where: { id: PLUGIN } });
    await new PluginRegistryService(bootstrapPrisma).consent({
      id: PLUGIN,
      packageName: `openbrf-plugin-${PLUGIN}`,
      version: "1.0.0",
      tarballUrl: `file:///dev/null/${PLUGIN}.tgz`,
      checksum: "sha512-unused-in-this-suite",
      permissions: ["addressBook:read"],
      personalData: ["name"],
      personRecords: PERSON_RECORDS,
      legalBasis: PROCESSING.legalBasis,
      actions: [],
      recipients: [],
      deviceRoutes: [],
      residentRoutes: RESIDENT_ROUTES,
      nonResidentCallers: SERVED,
      ai: false,
      licence: null,
    });
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
      street: "Visagatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 957,
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartments.a, addressId: address, number: "1701" },
      { id: apartments.b, addressId: address, number: "1702" },
    ],
  });
  await prisma.person.createMany({
    data: ACCOUNTS.map((personId) => ({
      id: personId,
      firstName: firstName(personId),
      lastName: lastName(personId),
    })),
  });
  const residency = (
    personId: string,
    apartmentId: string,
    movedOutOn: Date | null = null,
  ) => ({
    personId,
    apartmentId,
    role: "RESIDENT" as const,
    movedInOn: LONG_AGO,
    movedOutOn,
  });
  await prisma.residency.createMany({
    data: [
      residency(persons.a, apartments.a),
      residency(persons.b, apartments.b),
      residency(persons.c, apartments.a),
      residency(persons.boardResident, apartments.a),
      residency(persons.mover, apartments.b),
      residency(persons.turnsProtected, apartments.b),
      residency(persons.movingDuringRead, apartments.b),
      residency(
        persons.formerBoard,
        apartments.b,
        new Date("2024-06-30T00:00:00.000Z"),
      ),
    ],
  });
  await prisma.boardPosition.createMany({
    data: [persons.seat, persons.endingSeat, persons.formerBoard].map(
      (personId) => ({
        personId,
        position: "BOARD_MEMBER" as const,
        electedOn: LONG_AGO,
      }),
    ),
  });
  await prisma.systemRole.createMany({
    data: [
      { personId: persons.reader, role: "ADMIN" as const },
      { personId: persons.boardResident, role: "ADMIN" as const },
      { personId: persons.losingAdmin, role: "ADMIN" as const },
      { personId: persons.manager, role: "PROPERTY_MANAGER" as const },
      { personId: persons.withdrawnManager, role: "PROPERTY_MANAGER" as const },
    ],
  });
  await application()
    .get(ProcessingActivityService)
    .seedPlugin(PLUGIN, {
      name: "Efterlysningar",
      permissions: ["addressBook:read"],
      personalDataCategories: ["name"],
      processing: PROCESSING,
    });

  for (const personId of SIGNED_IN) {
    const email = `${personId}@exempel.se`;
    await application()
      .get(AuthService)
      .createAccountForPerson({
        personId,
        email,
        name: firstName(personId),
        password: PASSWORD,
      });
    cookies[personId] = await signIn(email);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (app !== undefined) {
      await prisma.pluginRecord.deleteMany({ where: { pluginId: PLUGIN } });
      await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN } });
      await prisma.processingActivity.deleteMany({
        where: { sourceKey: pluginProcessorKey(PLUGIN) },
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
      await prisma.apartment.deleteMany({
        where: { id: { in: Object.values(apartments) } },
      });
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

describe("only the subject chooses to be shown", () => {
  it("ignores a neighbour's tick on another person's record, and shows nothing of that person", async () => {
    const key = id("unticked");
    expect(
      (await residentPut(persons.b, key, persons.b)).error,
    ).toBeUndefined();
    expect(await storedFlag(key)).toBe(false);

    // A lists B's record and rewrites it, about B, ticked: a rewrite, and so
    // accepted, but not B's choice.
    const rewrite = await residentPut(persons.a, key, persons.b, true);
    expect(rewrite.error).toBeUndefined();
    expect(rewrite.result?.showSubject).toBe(false);
    expect(await storedFlag(key)).toBe(false);

    for (const reader of [
      persons.a,
      persons.b,
      persons.seat,
      persons.manager,
    ]) {
      const { record, body } = await readAs(reader, key);
      expect(record).toBeDefined();
      expect(record?.showSubject).toBe(false);
      expect(record?.shown).toBeUndefined();
      expectNothingOf(body, persons.b, record, apartments.b);
    }
  });

  it("shows the subject's name and apartment once the subject ticks, and keeps the tick through others' rewrites", async () => {
    const key = id("ticked");
    const own = await residentPut(persons.b, key, persons.b, true);
    expect(own.result?.showSubject).toBe(true);

    const { record } = await readAs(persons.a, key);
    expect(record?.shown).toEqual({
      name: nameOf(persons.b),
      apartment: expect.objectContaining({ id: apartments.b, number: "1702" }),
    });

    // A neighbour's rewrite, unticked and then without the field, keeps it.
    await residentPut(persons.a, key, persons.b, false);
    expect(await storedFlag(key)).toBe(true);
    await residentPut(persons.a, key, persons.b);
    expect(await storedFlag(key)).toBe(true);
    expect((await readAs(persons.a, key)).record?.shown?.name).toBe(
      nameOf(persons.b),
    );

    // The subject's own rewrite without the field withdraws it.
    await residentPut(persons.b, key, persons.b);
    expect(await storedFlag(key)).toBe(false);
    const after = await readAs(persons.a, key);
    expect(after.record?.shown).toBeUndefined();
    expectNothingOf(after.body, persons.b, after.record, apartments.b);

    // And unticked, explicitly.
    await residentPut(persons.b, key, persons.b, true);
    expect(await storedFlag(key)).toBe(true);
    await residentPut(persons.b, key, persons.b, false);
    expect(await storedFlag(key)).toBe(false);
  });

  it("shows the subject to every class of caller the plugin serves", async () => {
    const key = id("every-reader");
    await residentPut(persons.b, key, persons.b, true);
    for (const reader of [
      persons.a,
      persons.seat,
      persons.reader,
      persons.manager,
    ]) {
      const { record } = await readAs(reader, key);
      expect(record?.shown?.name).toBe(nameOf(persons.b));
      expect(record?.shown?.apartment?.id).toBe(apartments.b);
    }
    // `get` resolves it as `list` does.
    const answer = await call(persons.manager, `ads/get/${key}`);
    expect(
      (answer.json as Outcome<PluginPersonRecord>).result?.shown?.name,
    ).toBe(nameOf(persons.b));
  });

  it("stores false when a write gives a ticked record to somebody who has not chosen", async () => {
    // To the caller on a resident route: A's write without the field.
    const toCaller = id("to-caller");
    await residentPut(persons.b, toCaller, persons.b, true);
    const taken = await residentPut(persons.a, toCaller, persons.a);
    expect(taken.result?.subject).toBe(persons.a);
    expect(await storedFlag(toCaller)).toBe(false);
    // A's own session, so A's own tick is A's choice, about A alone.
    await residentPut(persons.a, toCaller, persons.a, true);
    expect(await storedFlag(toCaller)).toBe(true);

    // To a third person on a board route.
    const toThird = id("to-third");
    await residentPut(persons.b, toThird, persons.b, true);
    const given = await boardPut(persons.reader, toThird, persons.c, true);
    expect(given.result?.subject).toBe(persons.c);
    expect(await storedFlag(toThird)).toBe(false);
    expect((await readAs(persons.a, toThird)).record?.shown).toBeUndefined();
  });

  it("takes the tick on a board route only from the subject's own session", async () => {
    const key = id("board-route");
    // The board member's own record, written on the board route.
    await boardPut(persons.boardResident, key, persons.boardResident, true);
    expect(await storedFlag(key)).toBe(true);
    // Another board member's rewrite neither withdraws it nor sets it.
    await boardPut(persons.reader, key, persons.boardResident, false);
    expect(await storedFlag(key)).toBe(true);
    await boardPut(persons.boardResident, key, persons.boardResident, false);
    expect(await storedFlag(key)).toBe(false);
    await boardPut(persons.reader, key, persons.boardResident, true);
    expect(await storedFlag(key)).toBe(false);
  });

  it("ignores whatever a job sends", async () => {
    const ticked = id("job-ticked");
    await residentPut(persons.b, ticked, persons.b, true);
    // Handed over by a board member; the job runs outside every request.
    await boardPut(persons.reader, ticked, persons.b, false, "job");
    expect(await storedFlag(ticked)).toBe(true);

    const unticked = id("job-unticked");
    await residentPut(persons.b, unticked, persons.b);
    const job = await boardPut(
      persons.reader,
      unticked,
      persons.b,
      true,
      "job",
    );
    expect(job.error).toBeUndefined();
    expect(await storedFlag(unticked)).toBe(false);

    // A new record a job writes, even about the board member who handed it
    // over, starts unticked.
    const fresh = id("job-fresh");
    await boardPut(
      persons.boardResident,
      fresh,
      persons.boardResident,
      true,
      "job",
    );
    expect(await storedFlag(fresh)).toBe(false);
  });

  it("refuses the tick in a collection that does not declare showsSubject", async () => {
    const key = id("notes");
    const refused = await residentPut(persons.b, key, persons.b, true, "notes");
    expect(refused.error).toBe("RangeError");
    expect(await storedFlag(key)).toBeUndefined();
    const plain = await residentPut(persons.b, key, persons.b, false, "notes");
    expect(plain.result?.showSubject).toBe(false);
  });
});

describe("a name does not outlive its subject's being served", () => {
  it("shows a person served in a class with no apartment", async () => {
    for (const [key, subject] of [
      [id("class-seat"), persons.seat],
      [id("class-admin"), persons.reader],
      [id("class-manager"), persons.manager],
    ] as const) {
      await tickedRecord(key, subject);
      const { record } = await readAs(persons.a, key);
      expect(record?.shown).toEqual({ name: nameOf(subject), apartment: null });
    }
  });

  it("stops at once when the subject moves out", async () => {
    const key = id("mover");
    await tickedRecord(key, persons.mover);
    expect((await readAs(persons.a, key)).record?.shown?.name).toBe(
      nameOf(persons.mover),
    );
    await prisma.residency.updateMany({
      where: { personId: persons.mover },
      data: { movedOutOn: dateColumnOf(today) },
    });
    const { record, body } = await readAs(persons.a, key);
    // The record is still returned, before its erase date, without a name.
    expect(record?.value).toEqual({ note: "plats" });
    expect(record?.showSubject).toBe(true);
    expect(record?.shown).toBeUndefined();
    expectNothingOf(body, persons.mover, record, apartments.b);
  });

  it("stops when the subject's board seat ends", async () => {
    const key = id("ending-seat");
    await tickedRecord(key, persons.endingSeat);
    expect((await readAs(persons.a, key)).record?.shown).toBeDefined();
    await prisma.boardPosition.updateMany({
      where: { personId: persons.endingSeat },
      data: { endedOn: dateColumnOf(today) },
    });
    const { record, body } = await readAs(persons.a, key);
    expect(record?.shown).toBeUndefined();
    expectNothingOf(body, persons.endingSeat, record);
  });

  it("stops when the subject's system role is removed", async () => {
    const key = id("losing-admin");
    await tickedRecord(key, persons.losingAdmin);
    expect((await readAs(persons.a, key)).record?.shown).toBeDefined();
    await prisma.systemRole.deleteMany({
      where: { personId: persons.losingAdmin },
    });
    const { record, body } = await readAs(persons.a, key);
    expect(record?.shown).toBeUndefined();
    expectNothingOf(body, persons.losingAdmin, record);
  });

  it("never shows a former resident, whose board seat has not ended", async () => {
    const key = id("former-board");
    await tickedRecord(key, persons.formerBoard);
    const { record, body } = await readAs(persons.a, key);
    expect(record).toBeDefined();
    expect(record?.shown).toBeUndefined();
    expectNothingOf(body, persons.formerBoard, record, apartments.b);
  });

  it("leaves out the whole record once its subject is protected", async () => {
    const key = id("turns-protected");
    await tickedRecord(key, persons.turnsProtected);
    expect((await readAs(persons.a, key)).record?.shown).toBeDefined();
    await prisma.person.update({
      where: { id: persons.turnsProtected },
      data: { protectedPersonalData: true },
    });
    const { record, body } = await readAs(persons.a, key);
    expect(record).toBeUndefined();
    expectNothingOf(body, persons.turnsProtected);
  });

  it("stops when the install's consent to the subject's class is withdrawn", async () => {
    const key = id("withdrawn-manager");
    await tickedRecord(key, persons.withdrawnManager);
    expect((await readAs(persons.a, key)).record?.shown).toBeDefined();
    try {
      await prisma.installedPlugin.update({
        where: { id: PLUGIN },
        data: { consentedNonResidentCallers: ["board", "administrator"] },
      });
      const { record, body } = await readAs(persons.a, key);
      expect(record?.shown).toBeUndefined();
      expectNothingOf(body, persons.withdrawnManager, record);
    } finally {
      await prisma.installedPlugin.update({
        where: { id: PLUGIN },
        data: { consentedNonResidentCallers: SERVED },
      });
    }
  });

  it("follows the move-out date on the association's calendar: served the day before, not on the day", async () => {
    const addressBook = application().get(PluginAddressBookService);
    const leaving = id("leaving");
    await prisma.person.create({
      data: {
        id: leaving,
        firstName: firstName(leaving),
        lastName: lastName(leaving),
      },
    });
    try {
      await prisma.residency.create({
        data: {
          personId: leaving,
          apartmentId: apartments.b,
          role: "RESIDENT",
          movedInOn: LONG_AGO,
          movedOutOn: dateColumnOf(addLocalDays(today, 1)),
        },
      });
      await prisma.boardPosition.create({
        data: {
          personId: leaving,
          position: "BOARD_MEMBER",
          electedOn: LONG_AGO,
        },
      });
      // Noon on each day of the association's calendar: the day before the
      // move-out date, when the person still lives here, and the date itself.
      const dayBefore = instantAt(today, 12 * 60) ?? new Date();
      const onTheDay =
        instantAt(addLocalDays(today, 1), 12 * 60) ?? new Date(NaN);
      expect(
        (
          await addressBook.shownSubjects(PLUGIN, [leaving], SERVED, dayBefore)
        ).get(leaving)?.apartment?.id,
      ).toBe(apartments.b);
      expect(
        (await addressBook.shownSubjects(PLUGIN, [leaving], SERVED, onTheDay))
          .size,
      ).toBe(0);
    } finally {
      await prisma.boardPosition.deleteMany({ where: { personId: leaving } });
      await prisma.residency.deleteMany({ where: { personId: leaving } });
      await prisma.person.deleteMany({ where: { id: leaving } });
    }
  });
});

describe("a read is of one moment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Reads as `persons.a` with `change` committed, on another connection, in
   * the gap between the host reading the record and reading the subject's
   * name, which is where a write of the subject's or the board's can land
   * between the two. (Not `servedClasses`, which the resident route's guard
   * asks before the plugin's code runs.)
   */
  async function readWhile(
    key: string,
    change: () => Promise<unknown>,
  ): Promise<PluginPersonRecord | undefined> {
    // On the prototype, for the plugin's host is built with an instance of its
    // own and not the one the application hands out.
    const original = Object.getOwnPropertyDescriptor(
      PluginAddressBookService.prototype,
      "shownSubjects",
    )?.value as PluginAddressBookService["shownSubjects"];
    let changed = false;
    vi.spyOn(
      PluginAddressBookService.prototype,
      "shownSubjects",
    ).mockImplementation(async function (
      this: PluginAddressBookService,
      ...args: Parameters<PluginAddressBookService["shownSubjects"]>
    ) {
      if (!changed) {
        changed = true;
        await change();
      }
      return await original.apply(this, args);
    });
    const { record } = await readAs(persons.a, key);
    expect(changed).toBe(true);
    vi.restoreAllMocks();
    return record;
  }

  it("shows the name of the record as it was read when the subject moves out in between, and nothing on the next read", async () => {
    const key = id("snapshot-move-out");
    await tickedRecord(key, persons.movingDuringRead);
    const during = await readWhile(key, () =>
      prisma.residency.updateMany({
        where: { personId: persons.movingDuringRead },
        data: { movedOutOn: dateColumnOf(today) },
      }),
    );
    // The record and the name are of the same moment: before the move-out.
    expect(during?.showSubject).toBe(true);
    expect(during?.shown?.name).toBe(nameOf(persons.movingDuringRead));
    const after = (await readAs(persons.a, key)).record;
    expect(after?.showSubject).toBe(true);
    expect(after?.shown).toBeUndefined();
  });

  it("does not pair a name with a record whose subject chose otherwise by the time it was read", async () => {
    const key = id("snapshot-withdrawn");
    await tickedRecord(key, persons.c);
    const during = await readWhile(key, () =>
      prisma.pluginRecord.updateMany({
        where: { pluginId: PLUGIN, key },
        data: { showSubject: false },
      }),
    );
    // Whatever moment the read is of, its flag and its name agree.
    expect(during?.showSubject).toBe(true);
    expect(during?.shown?.name).toBe(nameOf(persons.c));
    const after = (await readAs(persons.a, key)).record;
    expect(after?.showSubject).toBe(false);
    expect(after?.shown).toBeUndefined();
  });

  it("names nobody for a record given to another subject in between", async () => {
    const key = id("snapshot-reassigned");
    await tickedRecord(key, persons.c);
    const during = await readWhile(key, () =>
      prisma.pluginRecord.updateMany({
        where: { pluginId: PLUGIN, key },
        data: { subjectPersonId: persons.b, showSubject: false },
      }),
    );
    // Either the record about c with c's name or the record about b without
    // one; never b's record carrying c's name.
    expect(during?.subject).toBe(persons.c);
    expect(during?.shown?.name).toBe(nameOf(persons.c));
    const after = (await readAs(persons.a, key)).record;
    expect(after?.subject).toBe(persons.b);
    expect(after?.shown).toBeUndefined();
  });
});

describe("the access report", () => {
  it("prints whether the subject chose to be shown, record by record", async () => {
    const shown = id("report-shown");
    const plain = id("report-plain");
    await residentPut(persons.b, shown, persons.b, true);
    await residentPut(persons.b, plain, persons.b);
    const report = await application()
      .get(DataSubjectReportService)
      .generate({ personId: persons.b, actorPersonId: persons.reader });
    const flags = new Map(
      report.pluginRecords
        .filter((record) => record.pluginId === PLUGIN)
        .map((record) => [record.key, record.showSubject]),
    );
    expect(flags.get(shown)).toBe(true);
    expect(flags.get(plain)).toBe(false);
  });
});

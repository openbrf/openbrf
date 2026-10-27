import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  PLUGIN_RECORD_LIMITS,
  PluginRecordConflictError,
  PluginRecordLimitError,
  PluginRecordOtherPersonError,
  PluginRecordRetentionError,
  PluginRecordSubjectError,
  type PluginPersonRecordCollection,
  type PluginProcessing,
} from "@openbrf/plugin-sdk";
import {
  addLocalDays,
  formatLocalDay,
  instantAt,
  localDayOf,
} from "@openbrf/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { AppModule } from "../app.module";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { ProcessingActivityService } from "../data-protection/processing-activity.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { erasureRemainder } from "../retention/erasure-domains";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { holdLockCount, waitFor } from "../testing/advisory-locks";
import { grantErasure } from "../testing/erasure-requests";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { installedPackageDirectory } from "./plugin-locales";
import {
  PluginPersonRecordsService,
  removePluginRecords,
} from "./plugin-person-records.service";
import { PluginRecordsPurgeService } from "./plugin-records-purge.service";
import { PluginRecordsService } from "./plugin-records.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { runOnResidentRoute } from "./resident-route-scope";

/**
 * A plugin's records about a person (ADR 0047), against a real database.
 *
 * What only the database can show: which person a record may name and which
 * records a plugin reads, decided by the same query the address book answers
 * with; what a legal hold keeps when the plugin overwrites or deletes; what the
 * purge erases by date and on a granted erasure request, with the closing
 * job's count beside it; what removal deletes and what it keeps; and that the
 * access report carries every row, labelled from the consented declaration and
 * the plugin's locale files on the volume.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let env: Env;
let personRecords: PluginPersonRecordsService;
let records: PluginRecordsService;
let purge: PluginRecordsPurgeService;
let registry: PluginRegistryService;
let processing: ProcessingActivityService;
let addressBook: PluginAddressBookService;
let reports: DataSubjectReportService;
let encryption: FieldEncryptionService;

const suffix = runSuffix();
const PLUGIN = `parking-${suffix}`.toLowerCase();
const PACKAGE = `@example/${PLUGIN}`;
const OTHER = `parking-other-${suffix}`.toLowerCase();

const address = `ppr-address-${suffix}`;
const apartment = `ppr-apartment-${suffix}`;
const persons = {
  board: `ppr-board-${suffix}`,
  resident: `ppr-resident-${suffix}`,
  neighbour: `ppr-neighbour-${suffix}`,
  mover: `ppr-mover-${suffix}`,
  protectedOne: `ppr-protected-${suffix}`,
  restricted: `ppr-restricted-${suffix}`,
  objector: `ppr-objector-${suffix}`,
  leaver: `ppr-leaver-${suffix}`,
  // Letters and digits alone, as the register makes an id.
  stranger: `pprstranger${suffix}`,
};
const personIds = Object.values(persons);

const CLAIMS: PluginPersonRecordCollection = {
  collection: "claims",
  titleKey: "records.claims.title",
  personalData: ["apartment"],
  keepAtMostDays: 730,
  fields: [
    { key: "space", labelKey: "records.claims.space", provided: true },
    { key: "status", labelKey: "records.claims.status", provided: false },
  ],
};
const DECLARED = [CLAIMS];

const PROCESSING: PluginProcessing = {
  purpose: {
    sv: "Låta grannar låna ut sina parkeringsplatser.",
    en: "Let neighbours lend each other their parking spaces.",
  },
  legalBasis: "contract",
  retention: { sv: "Två år.", en: "Two years." },
  dataSubjects: ["residents"],
};

const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
const LAST_YEAR = new Date(
  `${String(new Date().getUTCFullYear() - 1)}-01-15T00:00:00.000Z`,
);

/** A day on the association's calendar, `days` from today. */
function dayFromToday(days: number): string {
  return formatLocalDay(addLocalDays(localDayOf(new Date()), days));
}

/** Tonight's midnight on the association's calendar, `seconds` either side. */
function atMidnight(seconds: number): Date {
  const midnight = instantAt(addLocalDays(localDayOf(new Date()), 1), 0);
  if (midnight === null) {
    throw new Error("The association's calendar skips midnight tonight.");
  }
  return new Date(midnight.getTime() + seconds * 1000);
}

/**
 * The clock of a write sent a second before midnight that has its turn a
 * second after it: it reads before midnight until `pass` is called, which a
 * test does as soon as the call is sent and before the write has run.
 */
function midnightClock(): { clock: () => Date; pass: () => void } {
  let passed = false;
  return {
    clock: () => atMidnight(passed ? 1 : -1),
    pass: () => {
      passed = true;
    },
  };
}

function claim(
  subject: string,
  eraseOn = dayFromToday(30),
  space = "12",
): {
  subject: string;
  eraseOn: string;
  value: { space: string; status: string };
} {
  return { subject, eraseOn, value: { space, status: "confirmed" } };
}

async function clearRecords(): Promise<void> {
  await prisma.pluginRecord.deleteMany({
    where: { pluginId: { in: [PLUGIN, OTHER] } },
  });
  await prisma.legalHold.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.updateMany({
    where: { id: persons.resident },
    data: { processingRestrictedAt: null },
  });
}

/** Rows of this plugin's under a key, live and set aside, oldest first. */
async function rowsUnder(key: string) {
  return prisma.pluginRecord.findMany({
    where: { pluginId: PLUGIN, collection: "claims", key },
    orderBy: [{ setAsideAt: { sort: "asc", nulls: "last" } }],
    select: {
      revision: true,
      setAsideAt: true,
      updatedAt: true,
      value: true,
      subjectPersonId: true,
    },
  });
}

async function hold(personId: string): Promise<string> {
  const placed = await prisma.legalHold.create({
    data: {
      personId,
      reason: "Tvist om en parkeringsplats",
      placedByPersonId: persons.board,
    },
    select: { id: true },
  });
  return placed.id;
}

/**
 * A record about a person written straight to the table, as days go by: the
 * host refuses an erase date that has come, so only days passing make one.
 */
async function stored(
  key: string,
  subject: string,
  eraseOn: string,
  setAsideAt: Date | null = null,
  size = 13,
  value: Record<string, string> = { space: "1" },
  pluginId = PLUGIN,
): Promise<void> {
  await prisma.pluginRecord.create({
    data: {
      pluginId,
      collection: "claims",
      key,
      subjectPersonId: subject,
      eraseOn: new Date(`${eraseOn}T00:00:00.000Z`),
      setAsideAt,
      value,
      size,
    },
  });
}

/**
 * Rows of `host.records` that fill the plugin's store, beside what it holds,
 * to `count` rows and `bytes` in all, the bytes spread evenly over them. The
 * limits read the size column rather than the value, so a filler row's value
 * can be small while its size is up to one value's limit.
 */
async function fillTo(count: number, bytes: number): Promise<void> {
  const held = await prisma.pluginRecord.aggregate({
    where: { pluginId: PLUGIN },
    _count: { _all: true },
    _sum: { size: true },
  });
  const rows = count - held._count._all;
  const spare = bytes - (held._sum.size ?? 0);
  const each = Math.floor(spare / rows);
  expect(each + 1).toBeLessThanOrEqual(PLUGIN_RECORD_LIMITS.valueBytes);
  await prisma.pluginRecord.createMany({
    data: Array.from({ length: rows }, (_, index) => ({
      pluginId: PLUGIN,
      collection: "screens",
      key: `filler-${String(index)}`,
      value: 1,
      size: each + (index < spare % rows ? 1 : 0),
    })),
  });
}

/** Whether each row under a key is set aside, oldest first, the live one last. */
async function asideUnder(key: string): Promise<boolean[]> {
  return (await rowsUnder(key)).map((row) => row.setAsideAt !== null);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();

  prisma = app.get(PrismaService);
  env = app.get(ENV);
  personRecords = app.get(PluginPersonRecordsService);
  records = app.get(PluginRecordsService);
  purge = app.get(PluginRecordsPurgeService);
  registry = app.get(PluginRegistryService);
  processing = app.get(ProcessingActivityService);
  addressBook = app.get(PluginAddressBookService);
  reports = app.get(DataSubjectReportService);
  encryption = app.get(FieldEncryptionService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: {},
  });
  await prisma.address.create({
    data: {
      id: address,
      street: "Parkgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 950,
    },
  });
  await prisma.apartment.create({
    data: { id: apartment, addressId: address, number: "1301" },
  });
  await prisma.person.createMany({
    data: personIds.map((id) => ({
      id,
      firstName: "Förnamn",
      lastName: "Efternamn",
      protectedPersonalData: id === persons.protectedOne,
      processingRestrictedAt: id === persons.restricted ? new Date() : null,
    })),
  });
  await prisma.residency.createMany({
    data: [
      persons.resident,
      persons.neighbour,
      persons.protectedOne,
      persons.restricted,
      persons.objector,
    ]
      .map((personId) => ({
        personId,
        apartmentId: apartment,
        role: "RESIDENT" as const,
        movedInOn: LONG_AGO,
      }))
      .concat(
        [persons.mover, persons.leaver].map((personId) => ({
          personId,
          apartmentId: apartment,
          role: "RESIDENT" as const,
          movedInOn: LONG_AGO,
          movedOutOn: LAST_YEAR,
        })),
      ),
  });

  await registry.consent({
    id: PLUGIN,
    packageName: PACKAGE,
    version: "1.0.0",
    tarballUrl: "",
    checksum: "sha512-test",
    permissions: ["addressBook:read"],
    personalData: ["name", "apartment"],
    personRecords: DECLARED,
    legalBasis: PROCESSING.legalBasis,
    recipients: [],
    actions: [],
    ai: false,
    deviceRoutes: [],
    licence: null,
  });
  await registry.consent({
    id: OTHER,
    packageName: `@example/${OTHER}`,
    version: "1.0.0",
    tarballUrl: "",
    checksum: "sha512-test",
    permissions: ["addressBook:read"],
    personalData: ["name", "apartment"],
    personRecords: DECLARED,
    legalBasis: PROCESSING.legalBasis,
    recipients: [],
    actions: [],
    ai: false,
    deviceRoutes: [],
    licence: null,
  });
  await processing.seedPlugin(PLUGIN, {
    name: "Parkering",
    permissions: ["addressBook:read"],
    personalDataCategories: ["name", "apartment"],
    processing: PROCESSING,
  });
  const row = await prisma.processingActivity.findUniqueOrThrow({
    where: { sourceKey: pluginProcessorKey(PLUGIN) },
    select: { id: true },
  });
  await prisma.dataSubjectRequest.create({
    data: {
      personId: persons.objector,
      kind: "OBJECTION",
      requestedOn: LONG_AGO,
      ground: "Vill inte vara med.",
      processingActivityId: row.id,
      decision: "GRANTED",
      decidedAt: LONG_AGO,
      recordedByPersonId: persons.board,
      decidedByPersonId: persons.board,
    },
  });
}, 180_000);

beforeEach(async () => {
  await clearRecords();
});

afterAll(async () => {
  try {
    await clearRecords();
    await prisma.dataSubjectRequest.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.processingActivity.deleteMany({
      where: { sourceKey: pluginProcessorKey(PLUGIN) },
    });
    await prisma.installedPlugin.deleteMany({
      where: { id: { in: [PLUGIN, OTHER] } },
    });
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({ where: { id: apartment } });
    await prisma.address.deleteMany({ where: { id: address } });
    await rm(installedPackageDirectory(env.OPENBRF_DATA_DIR, PACKAGE), {
      recursive: true,
      force: true,
    });
  } finally {
    await app.close();
  }
});

describe("which person a record may name", () => {
  it("keeps a record about a resident the address book lists", async () => {
    const eraseOn = dayFromToday(120);
    const written = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, eraseOn),
    );

    expect(written).toMatchObject({
      collection: "claims",
      key: "space-12",
      subject: persons.resident,
      eraseOn,
      value: { space: "12", status: "confirmed" },
      revision: 1,
    });
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toEqual(written);
  });

  it("refuses everybody the address book leaves out, alike", async () => {
    for (const subject of [
      persons.protectedOne,
      persons.restricted,
      persons.objector,
      persons.board,
      persons.mover,
      `ppr-nobody-${suffix}`,
    ]) {
      await expect(
        personRecords.put(PLUGIN, DECLARED, "claims", "k", claim(subject)),
        subject,
      ).rejects.toBeInstanceOf(PluginRecordSubjectError);
    }
    await expect(
      prisma.pluginRecord.count({ where: { pluginId: PLUGIN } }),
    ).resolves.toBe(0);
  });

  it("rewrites a moved-out person's record about them, and nothing new", async () => {
    // Written while they lived here; the host's own row, as the plugin left it.
    await prisma.pluginRecord.create({
      data: {
        pluginId: PLUGIN,
        collection: "claims",
        key: "old-claim",
        subjectPersonId: persons.mover,
        eraseOn: new Date(`${dayFromToday(60)}T00:00:00.000Z`),
        value: { space: "3" },
        size: 13,
      },
    });

    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "old-claim",
        claim(persons.mover, dayFromToday(60), "3"),
      ),
    ).resolves.toMatchObject({ subject: persons.mover, revision: 2 });
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "new",
        claim(persons.mover),
      ),
    ).rejects.toBeInstanceOf(PluginRecordSubjectError);
  });
});

/**
 * ADR 0051: on a resident route the only person a new record or an audit entry
 * may name is the caller, beside whoever a record the plugin can read is about.
 * Whether anybody else is listed is never asked, so the refusal of a neighbour
 * the address book lists and of a person it leaves out are the same.
 */
describe("which person a record may name on a resident route", () => {
  const onRoute = <T>(work: () => T): T =>
    runOnResidentRoute(
      { pluginId: PLUGIN, request: {}, personId: persons.resident },
      work,
    );

  it("keeps a record about the caller", async () => {
    await expect(
      onRoute(() =>
        personRecords.put(
          PLUGIN,
          DECLARED,
          "claims",
          "mine",
          claim(persons.resident),
        ),
      ),
    ).resolves.toMatchObject({ subject: persons.resident, revision: 1 });
  });

  it("refuses a new record about anybody else, listed or not, alike", async () => {
    for (const subject of [
      persons.neighbour,
      persons.protectedOne,
      persons.board,
      `ppr-nobody-${suffix}`,
    ]) {
      await expect(
        onRoute(() =>
          personRecords.put(PLUGIN, DECLARED, "claims", "k", claim(subject)),
        ),
        subject,
      ).rejects.toBeInstanceOf(PluginRecordSubjectError);
    }
    await expect(
      prisma.pluginRecord.count({ where: { pluginId: PLUGIN } }),
    ).resolves.toBe(0);
  });

  it("rewrites a neighbour's record under its subject, and writes no new one", async () => {
    const offer = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "offer",
      claim(persons.neighbour),
    );

    await expect(
      onRoute(() =>
        personRecords.put(
          PLUGIN,
          DECLARED,
          "claims",
          "offer",
          claim(persons.neighbour, offer.eraseOn, "13"),
        ),
      ),
    ).resolves.toMatchObject({ subject: persons.neighbour, revision: 2 });
    await expect(
      onRoute(() =>
        personRecords.put(
          PLUGIN,
          DECLARED,
          "claims",
          "another",
          claim(persons.neighbour),
        ),
      ),
    ).rejects.toBeInstanceOf(PluginRecordSubjectError);
  });

  it("lets an audit entry name the caller, or a person a readable record is about, and nobody else", async () => {
    await expect(
      onRoute(() => personRecords.mayName(PLUGIN, persons.resident)),
    ).resolves.toBe(true);
    // Listed, and named off the route; on it, only once a record is about them.
    await expect(
      personRecords.mayName(PLUGIN, persons.neighbour),
    ).resolves.toBe(true);
    await expect(
      onRoute(() => personRecords.mayName(PLUGIN, persons.neighbour)),
    ).resolves.toBe(false);
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "offer",
      claim(persons.neighbour),
    );
    await expect(
      onRoute(() => personRecords.mayName(PLUGIN, persons.neighbour)),
    ).resolves.toBe(true);
    await expect(
      onRoute(() => personRecords.mayName(PLUGIN, persons.protectedOne)),
    ).resolves.toBe(false);
  });
});

describe("a record names its subject and nobody else", () => {
  const OTHERS = [
    persons.neighbour,
    persons.protectedOne,
    persons.restricted,
    persons.objector,
    persons.mover,
    persons.board,
    persons.stranger,
  ];

  it("refuses another person's id in a value, a property name or the key, whoever they are", async () => {
    for (const other of OTHERS) {
      for (const [key, value] of [
        ["space-12", { space: "12", holder: other }],
        ["space-12", { space: "12", offer: `offer:${other}` }],
        ["space-12", { space: "12", notes: ["a", { by: [other] }] }],
        ["space-12", { space: "12", [other]: "holder" }],
        [`offer:${other}`, { space: "12" }],
        [other, { space: "12" }],
      ] as const) {
        await expect(
          personRecords.put(PLUGIN, DECLARED, "claims", key, {
            subject: persons.resident,
            eraseOn: dayFromToday(30),
            value,
          }),
          `${other} in ${JSON.stringify([key, value])}`,
        ).rejects.toBeInstanceOf(PluginRecordOtherPersonError);
      }
    }
    await expect(
      prisma.pluginRecord.count({ where: { pluginId: PLUGIN } }),
    ).resolves.toBe(0);
  });

  it("finds an id of letters and digits joined to a word", async () => {
    for (const written of [
      `holder-${persons.stranger}`,
      `holder_${persons.stranger}`,
      `Offered by ${persons.stranger}.`,
    ]) {
      await expect(
        personRecords.put(PLUGIN, DECLARED, "claims", "space-12", {
          subject: persons.resident,
          eraseOn: dayFromToday(30),
          value: { space: "12", holder: written },
        }),
        written,
      ).rejects.toBeInstanceOf(PluginRecordOtherPersonError);
    }
  });

  it("keeps a record that names its own subject, and strings that are nobody's id", async () => {
    await expect(
      personRecords.put(PLUGIN, DECLARED, "claims", persons.resident, {
        subject: persons.resident,
        eraseOn: dayFromToday(30),
        value: {
          space: "12",
          claimer: persons.resident,
          offer: `offer:ppr-nobody-${suffix}`,
          note: "Lånas ut över helgen, P12.",
        },
      }),
    ).resolves.toMatchObject({ key: persons.resident, revision: 1 });
  });
});

describe("the erase date", () => {
  it("accepts tomorrow up to the collection's bound, and neither today, a day already past nor a day later", async () => {
    for (const eraseOn of [dayFromToday(1), dayFromToday(730)]) {
      await expect(
        personRecords.put(
          PLUGIN,
          DECLARED,
          "claims",
          `bound-${eraseOn}`,
          claim(persons.resident, eraseOn),
        ),
      ).resolves.toMatchObject({ eraseOn });
    }
    // Due as it is written: a record the plugin could never read, and one the
    // limits would not count.
    for (const eraseOn of [dayFromToday(0), "2020-01-01"]) {
      await expect(
        personRecords.put(
          PLUGIN,
          DECLARED,
          "claims",
          "past",
          claim(persons.resident, eraseOn),
        ),
        eraseOn,
      ).rejects.toBeInstanceOf(RangeError);
    }
    await expect(rowsUnder("past")).resolves.toEqual([]);
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "beyond",
        claim(persons.resident, dayFromToday(731)),
      ),
    ).rejects.toBeInstanceOf(PluginRecordRetentionError);
  });
});

describe("a write that waits past midnight", () => {
  it("is judged on the day it holds its locks, for the erase date", async () => {
    const tomorrow = dayFromToday(1);
    // Before midnight throughout, the same date is a day ahead.
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "on-time",
        claim(persons.resident, tomorrow),
        undefined,
        undefined,
        () => atMidnight(-1),
      ),
    ).resolves.toMatchObject({ eraseOn: tomorrow });

    const { clock, pass } = midnightClock();
    const late = personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "late",
      claim(persons.resident, tomorrow),
      undefined,
      undefined,
      clock,
    );
    pass();
    await expect(late).rejects.toBeInstanceOf(RangeError);
    await expect(rowsUnder("late")).resolves.toEqual([]);
  });

  it("is judged on the day it holds its locks, for the person it names", async () => {
    await prisma.residency.updateMany({
      where: { personId: persons.neighbour },
      data: { movedOutOn: new Date(`${dayFromToday(1)}T00:00:00.000Z`) },
    });
    try {
      // Moved out from midnight, so a new record about them comes too late.
      const { clock, pass } = midnightClock();
      const late = personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "moving",
        claim(persons.neighbour),
        undefined,
        undefined,
        clock,
      );
      pass();
      await expect(late).rejects.toBeInstanceOf(PluginRecordSubjectError);
      await expect(rowsUnder("moving")).resolves.toEqual([]);
    } finally {
      await prisma.residency.updateMany({
        where: { personId: persons.neighbour },
        data: { movedOutOn: null },
      });
    }
  });

  it("is judged on the day it holds its locks, for the records due", async () => {
    await stored("due-tonight", persons.resident, dayFromToday(1));
    await stored("held-tonight", persons.resident, dayFromToday(1));

    // Due from midnight: no record to delete, and a key free to write.
    const deleting = midnightClock();
    const deleted = personRecords.delete(
      PLUGIN,
      DECLARED,
      "claims",
      "due-tonight",
      undefined,
      undefined,
      deleting.clock,
    );
    deleting.pass();
    await expect(deleted).resolves.toBe(false);

    const writing = midnightClock();
    const written = records.put(
      PLUGIN,
      "claims",
      "held-tonight",
      { taken: true },
      undefined,
      writing.clock,
    );
    writing.pass();
    await expect(written).resolves.toMatchObject({ revision: 1 });
  });

  it("is judged on the day it holds a person's legal hold key, for the limits", async () => {
    // Under the key a due record about the resident, which the write clears,
    // and a record about the neighbour due from midnight. The store is full
    // in bytes until midnight frees the neighbour's 1 024.
    await stored("stale", persons.resident, dayFromToday(0));
    await stored("due-tonight", persons.neighbour, dayFromToday(1), null, 1024);
    await fillTo(300, PLUGIN_RECORD_LIMITS.totalBytes);
    const value = "x".repeat(100);

    // Before midnight throughout, the write is past the bytes in all.
    await expect(
      records.put(PLUGIN, "claims", "stale", value, undefined, () =>
        atMidnight(-1),
      ),
    ).rejects.toMatchObject({ limit: "totalBytes" });

    // The resident's key held across midnight, so the write takes its turn
    // and its plugin lock before midnight and the person's key after it.
    // The holder spells the key out, as `legal-hold-lock.ts` takes it.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${persons.resident}`}))`;
        await released;
      },
      // Open longer than the waits below, rather than the five seconds an
      // interactive transaction is given.
      { timeout: 60_000, maxWait: 20_000 },
    );
    try {
      await waitFor(
        async () => (await holdLockCount(prisma, persons.resident, true)) > 0n,
      );
      const { clock, pass } = midnightClock();
      const written = records.put(
        PLUGIN,
        "claims",
        "stale",
        value,
        undefined,
        clock,
      );
      await waitFor(
        async () => (await holdLockCount(prisma, persons.resident, false)) > 0n,
      );
      pass();
      release();
      await holder;
      await expect(written).resolves.toMatchObject({ revision: 1 });
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  }, 60_000);
});

describe("which records a plugin reads", () => {
  it("leaves out a record about a person under a restriction, and keeps its key taken", async () => {
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident),
    );
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-13",
      claim(persons.neighbour),
    );
    await prisma.person.update({
      where: { id: persons.resident },
      data: { processingRestrictedAt: new Date() },
    });

    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBeNull();
    await expect(
      personRecords.list(PLUGIN, DECLARED, "claims"),
    ).resolves.toMatchObject([{ key: "space-13" }]);
    await expect(
      personRecords.list(PLUGIN, DECLARED, "claims", {
        subject: persons.resident,
      }),
    ).resolves.toEqual([]);
    // The space is claimed, and the plugin is told so and nothing else.
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.neighbour),
        null,
      ),
    ).rejects.toMatchObject({
      name: "PluginRecordConflictError",
      actualRevision: null,
    });
    await expect(
      personRecords.delete(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBe(false);

    await prisma.person.update({
      where: { id: persons.resident },
      data: { processingRestrictedAt: null },
    });
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toMatchObject({ subject: persons.resident });
  });

  it("lists one person's records when asked", async () => {
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "a",
      claim(persons.resident),
    );
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "b",
      claim(persons.neighbour),
    );

    await expect(
      personRecords.list(PLUGIN, DECLARED, "claims", {
        subject: persons.neighbour,
      }),
    ).resolves.toMatchObject([{ key: "b", subject: persons.neighbour }]);
  });
});

describe("two plugins", () => {
  /** What each plugin wrote under the same collection, key and subject. */
  async function writeBoth(): Promise<void> {
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "ours"),
    );
    await personRecords.put(
      OTHER,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(60), "theirs"),
    );
  }

  /** The row each plugin holds under the key, live and set aside. */
  async function rowsOf(pluginId: string) {
    return prisma.pluginRecord.findMany({
      where: { pluginId, collection: "claims", key: "space-12" },
      select: { revision: true, setAsideAt: true, value: true },
    });
  }

  it("keeps a record of each under one key, and reads only its own", async () => {
    await writeBoth();

    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toMatchObject({
      value: { space: "ours" },
      eraseOn: dayFromToday(30),
      revision: 1,
    });
    await expect(
      personRecords.get(OTHER, DECLARED, "claims", "space-12"),
    ).resolves.toMatchObject({
      value: { space: "theirs" },
      eraseOn: dayFromToday(60),
      revision: 1,
    });
    for (const [pluginId, space] of [
      [PLUGIN, "ours"],
      [OTHER, "theirs"],
    ] as const) {
      await expect(
        personRecords.list(pluginId, DECLARED, "claims"),
      ).resolves.toMatchObject([{ key: "space-12", value: { space } }]);
      await expect(
        personRecords.list(pluginId, DECLARED, "claims", {
          subject: persons.resident,
        }),
      ).resolves.toMatchObject([{ key: "space-12", value: { space } }]);
    }
  });

  it("lists nothing of the other's, for a key or a person only the other has", async () => {
    await personRecords.put(
      OTHER,
      DECLARED,
      "claims",
      "space-13",
      claim(persons.neighbour),
    );

    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-13"),
    ).resolves.toBeNull();
    await expect(
      personRecords.list(PLUGIN, DECLARED, "claims"),
    ).resolves.toEqual([]);
    await expect(
      personRecords.list(PLUGIN, DECLARED, "claims", {
        subject: persons.neighbour,
      }),
    ).resolves.toEqual([]);
    await expect(
      personRecords.list(OTHER, DECLARED, "claims", {
        subject: persons.neighbour,
      }),
    ).resolves.toMatchObject([{ key: "space-13" }]);
  });

  it("writes over, and creates beside, only its own", async () => {
    await personRecords.put(
      OTHER,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(60), "theirs"),
    );

    // The other holds the key, and the key is still free to this plugin.
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.neighbour, dayFromToday(30), "ours"),
        null,
      ),
    ).resolves.toMatchObject({ revision: 1, subject: persons.neighbour });
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.neighbour, dayFromToday(30), "ours, again"),
        1,
      ),
    ).resolves.toMatchObject({ revision: 2 });

    // Its revision is not the other's: a write over revision 2 is refused
    // there, where the record is at 1.
    await expect(
      personRecords.put(
        OTHER,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.resident, dayFromToday(60), "theirs, again"),
        2,
      ),
    ).rejects.toMatchObject({
      name: "PluginRecordConflictError",
      actualRevision: 1,
    });
    await expect(rowsOf(OTHER)).resolves.toEqual([
      {
        revision: 1,
        setAsideAt: null,
        value: { space: "theirs", status: "confirmed" },
      },
    ]);
    await expect(
      personRecords.get(OTHER, DECLARED, "claims", "space-12"),
    ).resolves.toMatchObject({ subject: persons.resident, revision: 1 });
  });

  it("deletes only its own, and says there is nothing to delete where only the other has one", async () => {
    await writeBoth();

    await expect(
      personRecords.delete(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBe(true);
    await expect(
      personRecords.delete(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBe(false);

    await expect(rowsOf(PLUGIN)).resolves.toEqual([]);
    await expect(
      personRecords.get(OTHER, DECLARED, "claims", "space-12"),
    ).resolves.toMatchObject({ value: { space: "theirs" }, revision: 1 });
    await expect(
      personRecords.delete(OTHER, DECLARED, "claims", "space-12"),
    ).resolves.toBe(true);
  });

  it("sets aside only its own row when a hold keeps the person's record", async () => {
    await writeBoth();
    await hold(persons.resident);

    await expect(
      personRecords.delete(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBe(true);
    await expect(
      personRecords.put(
        OTHER,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.resident, dayFromToday(60), "theirs, again"),
      ),
    ).resolves.toMatchObject({ revision: 2 });

    const ours = await rowsOf(PLUGIN);
    expect(ours.map((row) => row.setAsideAt !== null)).toEqual([true]);
    // The other's overwrite set its own old row aside and wrote a new one.
    const theirs = (await rowsOf(OTHER)).sort(
      (left, right) => left.revision - right.revision,
    );
    expect(theirs.map((row) => row.setAsideAt !== null)).toEqual([true, false]);
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBeNull();
  });

  it("purges its own records on their day and leaves the other's under the same key and person", async () => {
    await stored("space-12", persons.resident, dayFromToday(0));
    await stored(
      "space-12",
      persons.resident,
      dayFromToday(30),
      null,
      13,
      { space: "theirs" },
      OTHER,
    );

    const summary = await purge.run();

    expect(summary.failed).toBe(0);
    await expect(rowsOf(PLUGIN)).resolves.toEqual([]);
    await expect(rowsOf(OTHER)).resolves.toMatchObject([
      { revision: 1, setAsideAt: null, value: { space: "theirs" } },
    ]);
    await expect(
      personRecords.get(OTHER, DECLARED, "claims", "space-12"),
    ).resolves.toMatchObject({ value: { space: "theirs" } });
  });

  it("removes its own records and keeps the other's, a person under a hold included", async () => {
    await writeBoth();
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "free",
      claim(persons.neighbour),
    );
    await hold(persons.resident);

    const removed = await prisma.$transaction((tx) =>
      removePluginRecords(tx, PLUGIN),
    );

    // The held person's record is set aside, the other's deleted.
    expect(removed).toEqual({ deleted: 1, setAside: 1 });
    await expect(
      prisma.pluginRecord.count({
        where: { pluginId: PLUGIN, setAsideAt: null },
      }),
    ).resolves.toBe(0);
    await expect(rowsOf(OTHER)).resolves.toMatchObject([
      { revision: 1, setAsideAt: null, value: { space: "theirs" } },
    ]);
    await expect(
      personRecords.get(OTHER, DECLARED, "claims", "space-12"),
    ).resolves.toMatchObject({ value: { space: "theirs" } });
  });
});

describe("the two stores", () => {
  it("reaches only a declared collection", async () => {
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "screens",
        "k",
        claim(persons.resident),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("treats a key a record of host.records holds as taken", async () => {
    await records.put(PLUGIN, "claims", "space-12", { left: "behind" });

    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBeNull();
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.resident),
      ),
    ).rejects.toBeInstanceOf(PluginRecordConflictError);
    // And the other way round.
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-13",
      claim(persons.resident),
    );
    await expect(records.get(PLUGIN, "claims", "space-13")).resolves.toBeNull();
    await expect(
      records.put(PLUGIN, "claims", "space-13", 1),
    ).rejects.toBeInstanceOf(PluginRecordConflictError);
  });
});

describe("what a legal hold keeps", () => {
  it("sets the replaced and the deleted record aside, and the plugin sees an ordinary write", async () => {
    const first = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "12"),
    );
    await hold(persons.resident);

    const rewritten = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "14"),
      1,
    );
    expect(rewritten).toMatchObject({ revision: 2, value: { space: "14" } });
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toEqual(rewritten);

    // The next day, so the hold keeps this version too.
    const tomorrow = () => atMidnight(3600);
    await expect(
      personRecords.delete(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        2,
        undefined,
        tomorrow,
      ),
    ).resolves.toBe(true);
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12", tomorrow()),
    ).resolves.toBeNull();

    // Both versions kept, each a row of its own, never written again.
    const rows = await rowsUnder("space-12");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.revision, row.setAsideAt !== null])).toEqual([
      [1, true],
      [2, true],
    ]);
    // Each as it was last written, not as when it was set aside.
    expect(rows.map((row) => row.updatedAt.toISOString())).toEqual([
      first.updatedAt,
      rewritten.updatedAt,
    ]);
    // And the key is free for a create-only write.
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.neighbour),
        null,
      ),
    ).resolves.toMatchObject({ subject: persons.neighbour, revision: 1 });
  });

  it("keeps one version a day for a key, the one the day's first write replaced", async () => {
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "before"),
    );
    await hold(persons.resident);

    // A plugin that rewrites the record on every request.
    let last = null;
    for (let write = 1; write <= 100; write++) {
      last = await personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.resident, dayFromToday(30), String(write)),
      );
    }
    // Every write an ordinary overwrite to the plugin.
    expect(last).toMatchObject({ revision: 101, value: { space: "100" } });
    let rows = await rowsUnder("space-12");
    expect(
      rows.map((row) => [row.setAsideAt !== null, row.value, row.revision]),
    ).toEqual([
      [true, { space: "before", status: "confirmed" }, 1],
      [false, { space: "100", status: "confirmed" }, 101],
    ]);

    // A delete the same day takes what the day wrote, and keeps nothing more.
    await expect(
      personRecords.delete(PLUGIN, DECLARED, "claims", "space-12"),
    ).resolves.toBe(true);
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "evening"),
      null,
    );
    await expect(asideUnder("space-12")).resolves.toEqual([true, false]);

    // The next day's first write keeps the record as that day found it, and
    // its later ones act in place again.
    const tomorrow = () => atMidnight(3600);
    for (const space of ["morning", "noon"]) {
      await personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        claim(persons.resident, dayFromToday(30), space),
        undefined,
        undefined,
        tomorrow,
      );
    }
    rows = await rowsUnder("space-12");
    expect(rows.map((row) => [row.setAsideAt !== null, row.value])).toEqual([
      [true, { space: "before", status: "confirmed" }],
      [true, { space: "evening", status: "confirmed" }],
      [false, { space: "noon", status: "confirmed" }],
    ]);
  });

  it("keeps a version a day for each person a key's record was about", async () => {
    await hold(persons.resident);
    await hold(persons.neighbour);
    for (const subject of [
      persons.resident,
      persons.neighbour,
      persons.resident,
      persons.neighbour,
    ]) {
      await personRecords.put(PLUGIN, DECLARED, "claims", "k", claim(subject));
    }

    // The resident's first version, then the neighbour's; the rewrites after
    // them acted in place.
    const rows = await rowsUnder("k");
    expect(
      rows.map((row) => [row.setAsideAt !== null, row.subjectPersonId]),
    ).toEqual([
      [true, persons.resident],
      [true, persons.neighbour],
      [false, persons.neighbour],
    ]);
  });

  it("overwrites and deletes in place where nothing holds the person", async () => {
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "k",
      claim(persons.resident),
    );
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "k",
      claim(persons.resident),
    );
    await personRecords.delete(PLUGIN, DECLARED, "claims", "k");

    await expect(rowsUnder("k")).resolves.toEqual([]);
  });
});

/**
 * A revision starts again from 1 when a key's record is written anew, so it
 * alone cannot tell the record a call read from one written since; the
 * identity can.
 */
describe("which record a write is over", () => {
  /** Writes a record about `subject` under the key, `times` times over. */
  async function writtenTimes(key: string, subject: string, times: number) {
    let last = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      key,
      claim(subject, dayFromToday(30), "1"),
      null,
    );
    for (let write = 2; write <= times; write++) {
      last = await personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        key,
        claim(subject, dayFromToday(30), String(write)),
        write - 1,
        last.identity,
      );
    }
    return last;
  }

  it("refuses a write over a record read before an erasure, once one written anew has reached its revision", async () => {
    // A call reads a claim at its second revision. Its person has moved out,
    // since the host carries out no erasure of a current resident, and a
    // record already about them is still rewritten about them.
    await stored("day", persons.leaver, dayFromToday(30));
    const read = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "day",
      claim(persons.leaver),
      1,
    );
    expect(read.revision).toBe(2);
    const request = await grantErasure(prisma, persons.leaver, persons.board);
    try {
      await purge.run();
    } finally {
      await prisma.dataSubjectRequest.delete({ where: { id: request.id } });
    }
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "day"),
    ).resolves.toBeNull();

    // The day is offered and claimed again before the call goes on.
    const anew = await writtenTimes("day", persons.neighbour, 2);
    expect(anew.revision).toBe(read.revision);
    expect(anew.identity).not.toBe(read.identity);

    const stale = {
      expectedRevision: read.revision,
      expectedIdentity: read.identity,
    };
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        claim(persons.neighbour, dayFromToday(30), "given back"),
        stale.expectedRevision,
        stale.expectedIdentity,
      ),
    ).rejects.toMatchObject({
      name: "PluginRecordConflictError",
      actualRevision: 2,
    });
    // The identity alone refuses as well, and so does a delete.
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        claim(persons.neighbour, dayFromToday(30), "given back"),
        undefined,
        stale.expectedIdentity,
      ),
    ).rejects.toBeInstanceOf(PluginRecordConflictError);
    await expect(
      personRecords.delete(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        stale.expectedRevision,
        stale.expectedIdentity,
      ),
    ).rejects.toBeInstanceOf(PluginRecordConflictError);
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "day"),
    ).resolves.toEqual(anew);

    // The new record's own identity goes through.
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        claim(persons.neighbour, dayFromToday(30), "3"),
        anew.revision,
        anew.identity,
      ),
    ).resolves.toMatchObject({ revision: 3, identity: anew.identity });
  });

  it("answers a write that names no identity by its revision alone, as before", async () => {
    const read = await writtenTimes("day", persons.resident, 2);
    await personRecords.delete(PLUGIN, DECLARED, "claims", "day");
    await writtenTimes("day", persons.neighbour, 2);

    // Without the identity, the record written anew satisfies the revision.
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        claim(persons.neighbour, dayFromToday(30), "over"),
        read.revision,
      ),
    ).resolves.toMatchObject({ revision: 3, value: { space: "over" } });
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        claim(persons.neighbour, dayFromToday(30), "no precondition"),
      ),
    ).resolves.toMatchObject({ revision: 4 });
    await expect(
      personRecords.delete(PLUGIN, DECLARED, "claims", "day", 4),
    ).resolves.toBe(true);
  });

  it("keeps a record's identity on every write over it, those a hold sets aside included", async () => {
    const first = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "12"),
    );
    await hold(persons.resident);

    const today = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "14"),
      1,
      first.identity,
    );
    // The next day, so the hold sets this version aside too.
    const tomorrow = () => atMidnight(3600);
    const next = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "16"),
      2,
      first.identity,
      tomorrow,
    );
    expect([today, next].map((record) => record.identity)).toEqual([
      first.identity,
      first.identity,
    ]);
    // Three rows under the key, two set aside and the live one, all one record.
    const rows = await prisma.pluginRecord.findMany({
      where: { pluginId: PLUGIN, collection: "claims", key: "space-12" },
      select: { identity: true, setAsideAt: true },
    });
    expect(rows.filter((row) => row.setAsideAt !== null)).toHaveLength(2);
    expect(new Set(rows.map((row) => row.identity))).toEqual(
      new Set([first.identity]),
    );

    // Deleted and written anew under the hold, it is another record.
    await expect(
      personRecords.delete(
        PLUGIN,
        DECLARED,
        "claims",
        "space-12",
        3,
        first.identity,
        tomorrow,
      ),
    ).resolves.toBe(true);
    const again = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, dayFromToday(30), "18"),
      null,
      undefined,
      tomorrow,
    );
    expect(again.revision).toBe(1);
    expect(again.identity).not.toBe(first.identity);
  });

  it("tells two records apart that were written in the same millisecond", async () => {
    const erased = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "day",
      claim(persons.resident),
    );
    const createdAt = (
      await prisma.pluginRecord.findFirstOrThrow({
        where: { pluginId: PLUGIN, key: "day", setAsideAt: null },
        select: { createdAt: true },
      })
    ).createdAt;
    await personRecords.delete(PLUGIN, DECLARED, "claims", "day");
    const anew = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "day",
      claim(persons.neighbour),
    );
    // As though the erasure and the new write had landed in one millisecond.
    await prisma.pluginRecord.updateMany({
      where: { pluginId: PLUGIN, key: "day", setAsideAt: null },
      data: { createdAt },
    });

    expect(anew.identity).not.toBe(erased.identity);
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        claim(persons.neighbour),
        1,
        erased.identity,
      ),
    ).rejects.toBeInstanceOf(PluginRecordConflictError);
  });

  it("refuses an identity where no record is, and says there is nothing to delete", async () => {
    const gone = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "day",
      claim(persons.resident),
    );
    await personRecords.delete(PLUGIN, DECLARED, "claims", "day");

    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        claim(persons.resident),
        undefined,
        gone.identity,
      ),
    ).rejects.toMatchObject({
      name: "PluginRecordConflictError",
      actualRevision: null,
    });
    await expect(
      personRecords.delete(
        PLUGIN,
        DECLARED,
        "claims",
        "day",
        undefined,
        gone.identity,
      ),
    ).resolves.toBe(false);
  });

  it("refuses an identity no read hands out, and one beside an expected revision of null", async () => {
    const written = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "day",
      claim(persons.resident),
    );
    const writtenIdentity = written.identity;
    if (writtenIdentity === undefined) throw new Error("no identity read");
    for (const identity of [
      "",
      "day",
      writtenIdentity.toUpperCase(),
      ` ${writtenIdentity}`,
      42,
    ]) {
      await expect(
        personRecords.put(
          PLUGIN,
          DECLARED,
          "claims",
          "day",
          claim(persons.resident),
          undefined,
          identity as string,
        ),
        String(identity),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        personRecords.delete(
          PLUGIN,
          DECLARED,
          "claims",
          "day",
          undefined,
          identity as string,
        ),
        String(identity),
      ).rejects.toBeInstanceOf(RangeError);
    }
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "other-day",
        claim(persons.resident),
        null,
        written.identity,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "day"),
    ).resolves.toEqual(written);
  });
});

/**
 * A record whose erase date has come is gone for the plugin, whether the purge
 * has deleted it or a hold or a restriction has kept it. Each case runs before
 * the purge and after it, which deletes one record of each pair and keeps the
 * other: the plugin must not be able to tell which.
 */
describe("a record past its erase date", () => {
  for (const purged of [false, true]) {
    const when = purged ? "after the purge" : "before the purge";

    /** Runs the purge, in the cases that come after it. */
    async function maybePurge(): Promise<void> {
      if (purged) {
        expect((await purge.run()).failed).toBe(0);
      }
    }

    it(`answers a held person's as anyone's, ${when}`, async () => {
      await stored("held", persons.resident, dayFromToday(0));
      await stored("free", persons.neighbour, dayFromToday(-1));
      await hold(persons.resident);
      await maybePurge();

      const pairs = [
        ["held", persons.resident],
        ["free", persons.neighbour],
      ] as const;
      for (const [key, subject] of pairs) {
        await expect(
          personRecords.get(PLUGIN, DECLARED, "claims", key),
          key,
        ).resolves.toBeNull();
        await expect(
          personRecords.list(PLUGIN, DECLARED, "claims", { subject }),
          key,
        ).resolves.toEqual([]);
        await expect(
          personRecords.delete(PLUGIN, DECLARED, "claims", key),
          key,
        ).resolves.toBe(false);
      }
      await expect(
        personRecords.list(PLUGIN, DECLARED, "claims"),
      ).resolves.toEqual([]);
      for (const [key, subject] of pairs) {
        await expect(
          personRecords.put(
            PLUGIN,
            DECLARED,
            "claims",
            key,
            claim(subject),
            null,
          ),
          key,
        ).resolves.toMatchObject({ subject, revision: 1 });
      }

      // The hold did keep the held one, set aside now and on the report; the
      // free one is gone.
      await expect(asideUnder("held")).resolves.toEqual([true, false]);
      await expect(asideUnder("free")).resolves.toEqual([false]);
      const report = await reports.generate({
        personId: persons.resident,
        actorPersonId: persons.board,
      });
      expect(
        report.pluginRecords
          .filter((row) => row.pluginId === PLUGIN)
          .map(
            (row) => `${row.key} ${row.setAsideAt === null ? "live" : "aside"}`,
          )
          .sort(),
      ).toEqual(["held aside", "held live"]);
    });

    it(`answers a restricted person's as a protected person's, ${when}`, async () => {
      // Both left out of the plugin's reads; only the restriction keeps a
      // record past its date.
      await stored("restricted", persons.restricted, dayFromToday(0));
      await stored("protected", persons.protectedOne, dayFromToday(0));
      await maybePurge();

      for (const key of ["restricted", "protected"]) {
        await expect(
          personRecords.delete(PLUGIN, DECLARED, "claims", key),
          key,
        ).resolves.toBe(false);
        // Free, rather than a key taken that reports no revision.
        await expect(
          personRecords.put(
            PLUGIN,
            DECLARED,
            "claims",
            key,
            claim(persons.neighbour),
            null,
          ),
          key,
        ).resolves.toMatchObject({ subject: persons.neighbour, revision: 1 });
      }
      await expect(asideUnder("restricted")).resolves.toEqual([true, false]);
      await expect(asideUnder("protected")).resolves.toEqual([false]);
    });

    it(`frees a held person's key for host.records as anyone's, ${when}`, async () => {
      await stored("held", persons.resident, dayFromToday(0));
      await stored("free", persons.neighbour, dayFromToday(0));
      await hold(persons.resident);
      await maybePurge();

      for (const key of ["held", "free"]) {
        await expect(
          records.put(PLUGIN, "claims", key, { left: "behind" }, null),
          key,
        ).resolves.toMatchObject({ revision: 1 });
      }
      await expect(asideUnder("held")).resolves.toEqual([true, false]);
      await expect(asideUnder("free")).resolves.toEqual([false]);
    });

    it(`refuses a held person who moved out as anyone who moved out, ${when}`, async () => {
      await stored("mover", persons.mover, dayFromToday(0));
      await stored("leaver", persons.leaver, dayFromToday(0));
      await hold(persons.mover);
      await maybePurge();

      for (const subject of [persons.mover, persons.leaver]) {
        await expect(
          personRecords.mayName(PLUGIN, subject),
          subject,
        ).resolves.toBe(false);
      }
      // No record left to rewrite about them, so each is a new record.
      for (const [key, subject] of [
        ["mover", persons.mover],
        ["leaver", persons.leaver],
      ] as const) {
        await expect(
          personRecords.put(PLUGIN, DECLARED, "claims", key, claim(subject)),
          key,
        ).rejects.toBeInstanceOf(PluginRecordSubjectError);
      }
      await expect(asideUnder("mover")).resolves.toEqual([false]);
    });
  }
});

describe("the limits", () => {
  /** What a write came to: written, or the limit that refused it. */
  async function outcome(write: Promise<unknown>): Promise<string> {
    try {
      await write;
      return "written";
    } catch (error) {
      if (error instanceof PluginRecordLimitError) {
        return error.limit;
      }
      throw error;
    }
  }

  /** One record about the held person and one about a person nobody holds. */
  async function heldAndFree(): Promise<void> {
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "held",
      claim(persons.resident),
    );
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "free",
      claim(persons.neighbour),
    );
    await hold(persons.resident);
  }

  /** The same write onto both records, and what each came to. */
  async function both(
    write: (key: string, subject: string) => Promise<unknown>,
  ): Promise<string[]> {
    return [
      await outcome(write("held", persons.resident)),
      await outcome(write("free", persons.neighbour)),
    ];
  }

  const overwrite = (space: string) => (key: string, subject: string) =>
    personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      key,
      claim(subject, undefined, space),
    );
  // The next day, so the hold sets the overwritten version aside as well,
  // rather than deleting in place what the day's overwrite wrote.
  const remove = (key: string) =>
    personRecords.delete(
      PLUGIN,
      DECLARED,
      "claims",
      key,
      undefined,
      undefined,
      () => atMidnight(3600),
    );
  const recreate = (key: string, subject: string) =>
    personRecords.put(PLUGIN, DECLARED, "claims", key, claim(subject), null);

  it("answers a held person's records as anyone's at the record count", async () => {
    await heldAndFree();
    await fillTo(PLUGIN_RECORD_LIMITS.records, 1024 * 1024);

    // A plugin at its limit cannot tell the held record by what it may do.
    await expect(both(overwrite("12"))).resolves.toEqual([
      "written",
      "written",
    ]);
    await both(remove);
    await expect(both(recreate)).resolves.toEqual(["written", "written"]);
    // The limit still holds, for both alike.
    await expect(
      both((key, subject) => recreate(`${key}-2`, subject)),
    ).resolves.toEqual(["records", "records"]);

    // The hold did keep what was replaced: those rows just do not count.
    await expect(rowsUnder("held")).resolves.toHaveLength(3);
    await expect(rowsUnder("free")).resolves.toHaveLength(1);
  });

  it("answers a held person's records as anyone's at the bytes in all", async () => {
    await heldAndFree();
    await fillTo(300, PLUGIN_RECORD_LIMITS.totalBytes);

    await expect(both(overwrite("12"))).resolves.toEqual([
      "written",
      "written",
    ]);
    await both(remove);
    await expect(both(recreate)).resolves.toEqual(["written", "written"]);
    // One byte more is past the limit, for both alike.
    await expect(both(overwrite("123"))).resolves.toEqual([
      "totalBytes",
      "totalBytes",
    ]);

    await expect(rowsUnder("held")).resolves.toHaveLength(3);
    await expect(rowsUnder("free")).resolves.toHaveLength(1);
  });

  /*
   * A plugin that fills its store with a record about a person among the rows,
   * and writes once more after that record's erase date: the purge has freed
   * its place unless a hold kept it, so a refusal would name the hold. Each
   * person on a store of their own, before the purge and after it.
   */
  for (const purged of [false, true]) {
    const when = purged ? "after the purge" : "before the purge";

    /** The store filled around one due record about `subject`, then purged. */
    async function fullAround(
      subject: string,
      count: number,
      bytes: number,
    ): Promise<void> {
      await clearRecords();
      await stored("probe", subject, dayFromToday(0), null, 1024);
      if (subject === persons.resident) {
        await hold(subject);
      }
      await fillTo(count, bytes);
      if (purged) {
        expect((await purge.run()).failed).toBe(0);
      }
    }

    const create = (key: string, space = "12") =>
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        key,
        claim(persons.neighbour, undefined, space),
        null,
      );

    it(`does not count a held person's record past its date at the record count, ${when}`, async () => {
      const outcomes: string[][] = [];
      for (const subject of [persons.resident, persons.neighbour]) {
        await fullAround(subject, PLUGIN_RECORD_LIMITS.records, 1024 * 1024);
        outcomes.push([
          await outcome(create("new-1")),
          await outcome(create("new-2")),
        ]);
      }
      expect(outcomes).toEqual([
        ["written", "records"],
        ["written", "records"],
      ]);
    });

    it(`does not count a held person's record past its date at the bytes in all, ${when}`, async () => {
      const outcomes: string[][] = [];
      for (const subject of [persons.resident, persons.neighbour]) {
        await fullAround(subject, 300, PLUGIN_RECORD_LIMITS.totalBytes);
        // The first fits in the probe's 1 024 bytes, the second does not.
        outcomes.push([
          await outcome(create("new-1")),
          await outcome(create("new-2", "1".repeat(1024))),
        ]);
        await expect(asideUnder("probe")).resolves.toEqual(
          subject === persons.resident || !purged ? [false] : [],
        );
      }
      expect(outcomes).toEqual([
        ["written", "totalBytes"],
        ["written", "totalBytes"],
      ]);
    });
  }
});

describe("the purge", () => {
  async function keysLeft(): Promise<string[]> {
    const rows = await prisma.pluginRecord.findMany({
      where: { pluginId: PLUGIN },
      select: { key: true },
      orderBy: { key: "asc" },
    });
    return rows.map((row) => row.key);
  }

  it("erases a record on its day, keeps one whose day has not come, and logs counts and no person", async () => {
    const before = new Date();
    await stored("due", persons.resident, dayFromToday(0));
    await stored(
      "overdue-aside",
      persons.resident,
      dayFromToday(-3),
      new Date(),
    );
    await stored("later", persons.resident, dayFromToday(1));

    const summary = await purge.run();

    expect(summary.failed).toBe(0);
    await expect(keysLeft()).resolves.toEqual(["later"]);
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "PLUGIN_RECORDS_PURGED", createdAt: { gte: before } },
      select: { targetPersonId: true, actorPersonId: true, context: true },
    });
    // Another suite's purge may write an entry in the same window; this run's
    // is the one that counts this plugin's collection.
    const ours = entries.filter(
      (row) =>
        (row.context as { collections?: Record<string, number> } | null)
          ?.collections?.[`${PLUGIN}/claims`] !== undefined,
    );
    expect(ours).toHaveLength(1);
    const [entry] = ours;
    expect(entry).toMatchObject({ targetPersonId: null, actorPersonId: null });
    const context = entry?.context as
      { collections: Record<string, number> } | undefined;
    expect(context?.collections[`${PLUGIN}/claims`]).toBe(2);
    expect(JSON.stringify(context)).not.toContain(persons.resident);
  });

  it("leaves a person under a legal hold alone, set-aside rows with them, until it is released", async () => {
    await stored("live", persons.resident, dayFromToday(-1));
    await stored("aside", persons.resident, dayFromToday(-1), new Date());
    const holdId = await hold(persons.resident);

    await purge.run();
    await expect(keysLeft()).resolves.toEqual(["aside", "live"]);

    await prisma.legalHold.update({
      where: { id: holdId },
      data: { releasedAt: new Date(), releaseReason: "Tvisten är löst" },
    });
    await purge.run();
    await expect(keysLeft()).resolves.toEqual([]);
  });

  it("erases every record of a person a granted erasure names, and the closing job's count says so", async () => {
    await stored("far-off", persons.leaver, dayFromToday(700));
    await stored("aside", persons.leaver, dayFromToday(700), new Date());
    await stored("not-theirs", persons.neighbour, dayFromToday(700));
    const request = await grantErasure(prisma, persons.leaver, persons.board);
    try {
      await expect(
        erasureRemainder(prisma, persons.leaver, new Date(), encryption),
      ).resolves.toContainEqual({ domain: "plugin records", owed: 2, kept: 0 });

      await purge.run();

      await expect(keysLeft()).resolves.toEqual(["not-theirs"]);
      const remainder = await erasureRemainder(
        prisma,
        persons.leaver,
        new Date(),
        encryption,
      );
      expect(remainder.map((domain) => domain.domain)).not.toContain(
        "plugin records",
      );
    } finally {
      await prisma.dataSubjectRequest.delete({ where: { id: request.id } });
    }
  });
});

describe("removing the plugin", () => {
  it("deletes what nothing holds, sets aside what a hold keeps, and leaves what is already aside", async () => {
    await records.put(PLUGIN, "screens", "hall", { layout: "grid" });
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "free",
      claim(persons.neighbour),
    );
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "held",
      claim(persons.resident),
    );
    const live = await personRecords.get(PLUGIN, DECLARED, "claims", "held");
    await prisma.pluginRecord.create({
      data: {
        pluginId: PLUGIN,
        collection: "claims",
        key: "held",
        subjectPersonId: persons.resident,
        eraseOn: new Date(`${dayFromToday(10)}T00:00:00.000Z`),
        setAsideAt: new Date("2026-01-01T00:00:00.000Z"),
        value: { space: "earlier" },
        size: 19,
      },
    });
    await hold(persons.resident);

    const removed = await prisma.$transaction((tx) =>
      removePluginRecords(tx, PLUGIN),
    );

    expect(removed).toEqual({ deleted: 2, setAside: 1 });
    const left = await prisma.pluginRecord.findMany({
      where: { pluginId: PLUGIN },
      select: { key: true, setAsideAt: true, revision: true, updatedAt: true },
    });
    expect(left).toHaveLength(2);
    expect(left.every((row) => row.key === "held")).toBe(true);
    expect(left.every((row) => row.setAsideAt !== null)).toBe(true);
    // Set aside and otherwise untouched: still dated when it was last written.
    const earlier = new Date("2026-01-01T00:00:00.000Z").getTime();
    const keptByRemoval = left.find(
      (row) => row.setAsideAt?.getTime() !== earlier,
    );
    expect(keptByRemoval?.updatedAt.toISOString()).toBe(live?.updatedAt);
  });
});

describe("the access report", () => {
  it("carries every record about the person, labelled from the consent and the plugin's own text", async () => {
    const directory = installedPackageDirectory(env.OPENBRF_DATA_DIR, PACKAGE);
    await mkdir(join(directory, "locales"), { recursive: true });
    await writeFile(
      join(directory, "locales", "sv.json"),
      JSON.stringify({
        records: { claims: { title: "Anspråk", space: "Plats" } },
      }),
    );

    const asideErasedOn = dayFromToday(120);
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, asideErasedOn),
    );
    await hold(persons.resident);
    await personRecords.delete(PLUGIN, DECLARED, "claims", "space-12");
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-13",
      claim(persons.resident, dayFromToday(150), "13"),
    );

    const report = await reports.generate({
      personId: persons.resident,
      actorPersonId: persons.board,
    });

    expect(report.pluginRecords).toHaveLength(2);
    const [aside, live] = report.pluginRecords;
    expect(aside).toMatchObject({
      pluginId: PLUGIN,
      pluginName: "Parkering",
      collection: "claims",
      title: { sv: "Anspråk", en: null },
      key: "space-12",
      eraseOn: asideErasedOn,
      legalBasis: "contract",
    });
    expect(aside?.setAsideAt).not.toBeNull();
    expect(live).toMatchObject({ key: "space-13", setAsideAt: null });
    expect(live?.fields).toEqual([
      {
        key: "space",
        label: { sv: "Plats", en: null },
        value: "13",
        provided: true,
      },
      // Declared, with no text in the plugin's files.
      { key: "status", label: null, value: "confirmed", provided: false },
    ]);
  });
});

describe("the access report, where the stored value and the declaration differ", () => {
  async function reportedFields(): Promise<
    { key: string; label: unknown; value: unknown; provided: boolean }[]
  > {
    const report = await reports.generate({
      personId: persons.resident,
      actorPersonId: persons.board,
    });
    expect(report.pluginRecords).toHaveLength(1);
    return report.pluginRecords[0]?.fields ?? [];
  }

  it("leaves out a declared field the stored value does not hold", async () => {
    await stored("partial", persons.resident, dayFromToday(30), null, 13, {
      space: "7",
    });

    const fields = await reportedFields();

    expect(fields.map((field) => field.key)).toEqual(["space"]);
  });

  it("prints a key the declaration does not name as the plugin's own, unlabelled and not provided", async () => {
    await stored("extra", persons.resident, dayFromToday(30), null, 13, {
      space: "7",
      note: "kept for the plugin's own use",
    });

    const fields = await reportedFields();

    expect(fields.find((field) => field.key === "note")).toEqual({
      key: "note",
      label: null,
      value: "kept for the plugin's own use",
      provided: false,
    });
  });

  it("names a removed plugin's record from the record of processing activities, with no legal basis of the plugin's", async () => {
    const gone = `${PLUGIN}-gone`;
    await processing.seedPlugin(gone, {
      name: "Parkering (borttagen)",
      permissions: ["addressBook:read"],
      personalDataCategories: ["name"],
      processing: PROCESSING,
    });
    try {
      await stored(
        "left-behind",
        persons.resident,
        dayFromToday(30),
        new Date(),
        13,
        { space: "3" },
        gone,
      );

      const report = await reports.generate({
        personId: persons.resident,
        actorPersonId: persons.board,
      });

      expect(report.pluginRecords).toHaveLength(1);
      expect(report.pluginRecords[0]).toMatchObject({
        pluginId: gone,
        pluginName: "Parkering (borttagen)",
        title: null,
        legalBasis: null,
        fields: [{ key: "space", label: null, value: "3", provided: false }],
      });
    } finally {
      await prisma.pluginRecord.deleteMany({ where: { pluginId: gone } });
      await prisma.processingActivity.deleteMany({
        where: { sourceKey: pluginProcessorKey(gone) },
      });
    }
  });

  it("falls back to the plugin's id when nothing else names a removed plugin", async () => {
    const nameless = `${PLUGIN}-nameless`;
    try {
      await stored(
        "left-behind",
        persons.resident,
        dayFromToday(30),
        new Date(),
        13,
        { space: "3" },
        nameless,
      );

      const report = await reports.generate({
        personId: persons.resident,
        actorPersonId: persons.board,
      });

      expect(report.pluginRecords).toHaveLength(1);
      expect(report.pluginRecords[0]).toMatchObject({
        pluginId: nameless,
        pluginName: nameless,
        legalBasis: null,
      });
    } finally {
      await prisma.pluginRecord.deleteMany({ where: { pluginId: nameless } });
    }
  });
});

describe("who is calling", () => {
  it("answers a listed resident as the list does, and everybody else as not listed", async () => {
    await expect(
      addressBook.caller(PLUGIN, persons.resident, { contact: false }),
    ).resolves.toMatchObject({
      kind: "listed",
      resident: { personId: persons.resident },
    });
    for (const personId of [
      persons.board,
      persons.mover,
      persons.protectedOne,
      persons.restricted,
      persons.objector,
      null,
    ]) {
      await expect(
        addressBook.caller(PLUGIN, personId, { contact: false }),
      ).resolves.toEqual({ kind: "notListed" });
    }
  });
});

describe("an audit entry's subject", () => {
  it("may name a listed resident, or a person a readable record is about, and nobody else", async () => {
    await prisma.pluginRecord.create({
      data: {
        pluginId: PLUGIN,
        collection: "claims",
        key: "old-claim",
        subjectPersonId: persons.mover,
        eraseOn: new Date(`${dayFromToday(60)}T00:00:00.000Z`),
        value: { space: "3" },
        size: 13,
      },
    });

    await expect(personRecords.mayName(PLUGIN, persons.resident)).resolves.toBe(
      true,
    );
    await expect(personRecords.mayName(PLUGIN, persons.mover)).resolves.toBe(
      true,
    );
    await expect(
      personRecords.mayName(PLUGIN, persons.protectedOne),
    ).resolves.toBe(false);
    await expect(personRecords.mayName(PLUGIN, persons.board)).resolves.toBe(
      false,
    );
  });
});

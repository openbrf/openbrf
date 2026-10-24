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
  PluginRecordRetentionError,
  PluginRecordSubjectError,
  type PluginPersonRecordCollection,
  type PluginProcessing,
} from "@openbrf/plugin-sdk";
import { addLocalDays, formatLocalDay, localDayOf } from "@openbrf/shared";
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
  await prisma.pluginRecord.deleteMany({ where: { pluginId: PLUGIN } });
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
    await prisma.installedPlugin.deleteMany({ where: { id: PLUGIN } });
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
    const written = await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, "2027-03-01"),
    );

    expect(written).toMatchObject({
      collection: "claims",
      key: "space-12",
      subject: persons.resident,
      eraseOn: "2027-03-01",
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

describe("the erase date", () => {
  it("accepts the collection's bound and a day already past, and nothing later", async () => {
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "bound",
        claim(persons.resident, dayFromToday(730)),
      ),
    ).resolves.toMatchObject({ eraseOn: dayFromToday(730) });
    await expect(
      personRecords.put(
        PLUGIN,
        DECLARED,
        "claims",
        "past",
        claim(persons.resident, "2020-01-01"),
      ),
    ).resolves.toMatchObject({ eraseOn: "2020-01-01" });
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

    await expect(
      personRecords.delete(PLUGIN, DECLARED, "claims", "space-12", 2),
    ).resolves.toBe(true);
    await expect(
      personRecords.get(PLUGIN, DECLARED, "claims", "space-12"),
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
  const remove = (key: string) =>
    personRecords.delete(PLUGIN, DECLARED, "claims", key);
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
});

describe("the purge", () => {
  /** A record about a person written straight to the table, as days go by. */
  async function stored(
    key: string,
    subject: string,
    eraseOn: string,
    setAsideAt: Date | null = null,
  ): Promise<void> {
    await prisma.pluginRecord.create({
      data: {
        pluginId: PLUGIN,
        collection: "claims",
        key,
        subjectPersonId: subject,
        eraseOn: new Date(`${eraseOn}T00:00:00.000Z`),
        setAsideAt,
        value: { space: "1" },
        size: 13,
      },
    });
  }

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
    expect(entries).toHaveLength(1);
    const [entry] = entries;
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

    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-12",
      claim(persons.resident, "2027-03-01"),
    );
    await hold(persons.resident);
    await personRecords.delete(PLUGIN, DECLARED, "claims", "space-12");
    await personRecords.put(
      PLUGIN,
      DECLARED,
      "claims",
      "space-13",
      claim(persons.resident, "2027-04-01", "13"),
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
      eraseOn: "2027-03-01",
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

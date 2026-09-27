import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { hashOpaqueToken } from "../auth/opaque-token";
import { PrismaService } from "../database/prisma.service";
import type {
  AuditAction,
  AuditChannel,
  ResidencyRole,
} from "../generated/prisma/enums";
import { PluginLoaderService } from "../plugins/plugin-loader.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { ManagementListener } from "./management-listener";
import type { ManagementSummary } from "./management-summary";
import { ManagementSummaryService } from "./management-summary.service";

/**
 * The management API's document against a real database (ADR 0021).
 *
 * The worker's database holds whatever the suites before this one left, so
 * the counts are asserted as what this suite's own rows added to them. The
 * register seeded here has one person for each rule the document draws: a
 * member with protected personal data and one with a restriction, who are
 * members whatever the address book shows; residents who were invited and
 * residents who were not; a board member and an administrator, who are never
 * invited residents; and periods that ended or have not begun.
 *
 * No client address is involved - the listener keys nothing on one - so the
 * suite holds no subnet of its own.
 */

loadEnvForIntegrationTests();

const suffix = runSuffix();
const TOKEN = `management-int-spec-token-${suffix}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let summaries: ManagementSummaryService;
let listener: ManagementListener;

const previous = {
  port: process.env.OPENBRF_MANAGEMENT_PORT,
  digest: process.env.OPENBRF_MANAGEMENT_TOKEN_DIGEST,
};

const addressId = `management-address-${suffix}`;
const apartmentIds = [1, 2, 3].map(
  (index) => `management-apartment-${String(index)}-${suffix}`,
);
const [A1, A2, A3] = apartmentIds as [string, string, string];
const mediaFileId = `management-media-${suffix}`;
const STORED_BYTES = 123_457;

function personId(role: string): string {
  return `management-${role}-${suffix}`;
}

const person = {
  member: personId("member"),
  protectedMember: personId("protected-member"),
  restrictedMember: personId("restricted-member"),
  residentWithAccount: personId("resident-account"),
  residentExpiredInvitation: personId("resident-expired"),
  residentOpenInvitation: personId("resident-open"),
  boardMember: personId("board-member"),
  administrator: personId("administrator"),
  movedOut: personId("moved-out"),
  movingInLater: personId("moving-in-later"),
  formerBoardMember: personId("former-board"),
  electedLater: personId("elected-later"),
};
const personIds = Object.values(person);

/** A day far enough ahead that no other suite's rows are later. */
function farDay(day: string): Date {
  return new Date(`2099-${day}T10:00:00Z`);
}

let before: ManagementSummary;

async function summaryEntries(): Promise<number> {
  return prisma.auditLogEntry.count({
    where: { action: "INSTANCE_SUMMARY_READ" },
  });
}

function readThroughTheListener(token = TOKEN) {
  return listener.server.inject({
    method: "GET",
    url: "/v1/summary",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function entry(
  action: AuditAction,
  channel: AuditChannel | null,
  actorPersonId: string,
  createdAt?: Date,
): Promise<void> {
  // Straight to the table, so a channel can be absent and a time chosen. The
  // trigger permits it: it fires before an update or a delete, and this is
  // an insert.
  await prisma.auditLogEntry.create({
    data: {
      action,
      channel,
      actorPersonId,
      targetKind: "management-int-spec",
      targetId: suffix,
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  });
}

beforeAll(async () => {
  process.env.OPENBRF_MANAGEMENT_PORT = "3901";
  process.env.OPENBRF_MANAGEMENT_TOKEN_DIGEST = hashOpaqueToken(TOKEN);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();

  prisma = app.get(PrismaService);
  summaries = app.get(ManagementSummaryService);
  listener = app.get(ManagementListener);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  before = await summaries.read();

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Hanteringsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: apartmentIds.map((id, index) => ({
          id,
          number: String(1001 + index),
          floor: 0,
        })),
      },
    },
  });

  await prisma.person.createMany({
    data: personIds.map((id) => ({
      id,
      firstName: "Test",
      lastName: `Hantering${suffix}`,
      protectedPersonalData: id === person.protectedMember,
      processingRestrictedAt:
        id === person.restrictedMember ? new Date() : null,
    })),
  });

  // Held since 2020 and not ended: every one of these is held today.
  const current: {
    personId: string;
    apartmentId: string;
    role: ResidencyRole;
  }[] = [
    { personId: person.member, apartmentId: A1, role: "MEMBER" },
    { personId: person.protectedMember, apartmentId: A2, role: "MEMBER" },
    { personId: person.restrictedMember, apartmentId: A1, role: "MEMBER" },
    {
      personId: person.residentWithAccount,
      apartmentId: A1,
      role: "RESIDENT",
    },
    {
      personId: person.residentExpiredInvitation,
      apartmentId: A2,
      role: "RESIDENT",
    },
    {
      personId: person.residentOpenInvitation,
      apartmentId: A3,
      role: "RESIDENT",
    },
    { personId: person.boardMember, apartmentId: A3, role: "MEMBER" },
    { personId: person.administrator, apartmentId: A3, role: "RESIDENT" },
  ];
  await prisma.residency.createMany({
    data: current.map((row) => ({
      ...row,
      movedInOn: new Date("2020-01-01"),
    })),
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: person.movedOut,
        apartmentId: A1,
        role: "MEMBER",
        movedInOn: new Date("2018-01-01"),
        movedOutOn: new Date("2019-06-30"),
      },
      {
        personId: person.movingInLater,
        apartmentId: A2,
        role: "RESIDENT",
        movedInOn: new Date("2099-01-01"),
      },
    ],
  });

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: person.boardMember,
        position: "BOARD_MEMBER",
        electedOn: new Date("2025-01-01"),
      },
      {
        personId: person.formerBoardMember,
        position: "CHAIR",
        electedOn: new Date("2020-01-01"),
        endedOn: new Date("2021-06-30"),
      },
      {
        personId: person.electedLater,
        position: "DEPUTY_BOARD_MEMBER",
        electedOn: new Date("2099-01-01"),
      },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: person.administrator, role: "ADMIN" },
  });

  // An account is all "has an account" asks; how it came to exist is not
  // this suite's subject.
  for (const id of [
    person.residentWithAccount,
    person.boardMember,
    person.administrator,
    person.movedOut,
  ]) {
    await prisma.user.create({
      data: { name: "Test Person", email: `${id}@exempel.se`, personId: id },
    });
  }
  await prisma.invitation.createMany({
    data: [
      {
        personId: person.residentExpiredInvitation,
        tokenHash: `management-expired-${suffix}`,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
      {
        personId: person.residentOpenInvitation,
        tokenHash: `management-open-${suffix}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ],
  });

  await prisma.mediaFile.create({
    data: {
      id: mediaFileId,
      storageKey: `management-${suffix}`,
      // Nothing serves or opens it: only its size is read.
      encryption: "SECRETSTREAM_64K",
      dataKeyCipher: `management-${suffix}`,
      contentType: "application/pdf",
      byteSize: STORED_BYTES,
      checksum: "0".repeat(64),
      fileName: "arsredovisning.pdf",
    },
  });
});

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      /*
       * The entries this suite wrote stay: the log is append-only, and every
       * suite leaves its own. The ones dated ahead name people deleted here,
       * who hold no seat afterwards, so they reach no later reading.
       */
      await prisma.mediaFile.deleteMany({ where: { id: mediaFileId } });
      await prisma.invitation.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.systemRole.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.apartment.deleteMany({
        where: { id: { in: apartmentIds } },
      });
      await prisma.address.deleteMany({ where: { id: addressId } });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await app?.close();
    restoreEnvironmentVariable("OPENBRF_MANAGEMENT_PORT", previous.port);
    restoreEnvironmentVariable(
      "OPENBRF_MANAGEMENT_TOKEN_DIGEST",
      previous.digest,
    );
  }
});

describe("the counts", () => {
  it("counts the register from its own tables, the protected included", async () => {
    const after = await summaries.read();

    expect(after.claimed).toBe(true);
    expect(after.apartments - before.apartments).toBe(3);
    expect(after.register.persons - before.register.persons).toBe(12);
    // The member with protected personal data and the one with a restriction
    // are members: the address book leaves them out, a billing basis cannot.
    expect(after.register.members - before.register.members).toBe(4);
    expect(after.register.residents - before.register.residents).toBe(8);
    // The seat that ended and the one that has not begun are not held today.
    expect(after.register.boardSeats - before.register.boardSeats).toBe(1);
    expect(after.register.administrators - before.register.administrators).toBe(
      1,
    );
  });

  it("counts a resident with an account or an open invitation as invited, and nobody else", async () => {
    const after = await summaries.read();

    // The resident with an account and the one with an open invitation. Not
    // the resident whose invitation expired, the board member or the
    // administrator with accounts, or the account of somebody who moved out.
    expect(after.invitedResidents - before.invitedResidents).toBe(2);
  });

  it("stops counting a resident once elected to the board", async () => {
    const counted = (await summaries.read()).invitedResidents;
    const seat = await prisma.boardPosition.create({
      data: {
        personId: person.residentWithAccount,
        position: "DEPUTY_BOARD_MEMBER",
        electedOn: new Date("2025-06-01"),
      },
    });
    try {
      expect((await summaries.read()).invitedResidents).toBe(counted - 1);
    } finally {
      await prisma.boardPosition.delete({ where: { id: seat.id } });
    }
  });

  it("counts the stored files' sizes and the database's", async () => {
    const after = await summaries.read();

    expect(after.storage.storedFileBytes - before.storage.storedFileBytes).toBe(
      STORED_BYTES,
    );
    expect(after.storage.databaseBytes).toBeGreaterThan(0);
  });

  it("counts extracts generated through a person's channels, and no others", async () => {
    const start = await summaries.read();

    await entry("MEMBER_REGISTER_EXTRACT_GENERATED", "WEB", person.boardMember);
    await entry("MEMBER_REGISTER_EXTRACT_GENERATED", null, person.boardMember);
    await entry(
      "MEMBER_REGISTER_EXTRACT_GENERATED",
      "SYSTEM",
      person.boardMember,
    );
    await entry(
      "APARTMENT_REGISTER_EXTRACT_GENERATED",
      "MCP",
      person.boardMember,
    );
    await entry(
      "APARTMENT_REGISTER_EXTRACT_GENERATED",
      "MANAGEMENT",
      person.boardMember,
    );

    const after = await summaries.read();
    expect(
      after.registerExtracts.memberRegister -
        start.registerExtracts.memberRegister,
    ).toBe(2);
    expect(
      after.registerExtracts.apartmentRegister -
        start.registerExtracts.apartmentRegister,
    ).toBe(1);
  });

  it("states the migrations the image carries against the database", async () => {
    const directory = join(process.cwd(), "prisma", "migrations");
    const folders = readdirSync(directory, { withFileTypes: true })
      .filter(
        (candidate) =>
          candidate.isDirectory() &&
          existsSync(join(directory, candidate.name, "migration.sql")),
      )
      .map((candidate) => candidate.name)
      .sort();

    const { migrations } = await summaries.read();

    expect(migrations).toEqual({
      shipped: folders.length,
      applied: folders.length,
      failed: 0,
      pending: 0,
      latest: folders.at(-1),
    });
  });

  it("says the database answered", async () => {
    const { health } = await summaries.read();

    expect(health.database).toBe("ok");
    expect(health.pluginFindings).toBe(
      app.get(PluginLoaderService).report().length,
    );
  });
});

describe("the day the board was last active", () => {
  it("is read from a session, then an entry, and never from the system", async () => {
    const board = await prisma.user.findUniqueOrThrow({
      where: { personId: person.boardMember },
      select: { id: true },
    });
    const resident = await prisma.user.findUniqueOrThrow({
      where: { personId: person.residentWithAccount },
      select: { id: true },
    });

    // A session the board member renewed.
    await prisma.session.create({
      data: {
        userId: board.id,
        token: `management-board-${suffix}`,
        expiresAt: farDay("12-31"),
        updatedAt: farDay("03-01"),
      },
    });
    expect((await summaries.read()).boardActivityOn).toBe("2099-03-01");

    // A resident's is nobody's board activity.
    await prisma.session.create({
      data: {
        userId: resident.id,
        token: `management-resident-${suffix}`,
        expiresAt: farDay("12-31"),
        updatedAt: farDay("04-01"),
      },
    });
    expect((await summaries.read()).boardActivityOn).toBe("2099-03-01");

    // An act through the web interface, later than the session.
    await entry("NEWS_PUBLISHED", "WEB", person.boardMember, farDay("03-05"));
    expect((await summaries.read()).boardActivityOn).toBe("2099-03-05");

    // The system's own jobs and the management API's reads are not the
    // board's activity, however late.
    await entry(
      "SERVICE_DATA_PURGED",
      "SYSTEM",
      person.boardMember,
      farDay("03-09"),
    );
    await entry(
      "NEWS_PUBLISHED",
      "MANAGEMENT",
      person.boardMember,
      farDay("03-10"),
    );
    expect((await summaries.read()).boardActivityOn).toBe("2099-03-05");

    // An entry written before the log recorded a channel counts.
    await entry("NEWS_PUBLISHED", null, person.boardMember, farDay("03-07"));
    expect((await summaries.read()).boardActivityOn).toBe("2099-03-07");

    // The administrator is somebody running the association too.
    await entry(
      "PLUGIN_INSTALLED",
      "WEB",
      person.administrator,
      farDay("03-08"),
    );
    expect((await summaries.read()).boardActivityOn).toBe("2099-03-08");

    // And a day on the association's calendar: 23:30 UTC on the 8th of
    // March is half past midnight on the 9th in Stockholm.
    await entry(
      "NEWS_PUBLISHED",
      "MCP",
      person.boardMember,
      new Date("2099-03-08T23:30:00Z"),
    );
    expect((await summaries.read()).boardActivityOn).toBe("2099-03-09");
  });
});

describe("the entry every read writes", () => {
  it("is written on the management channel, with no actor and no target", async () => {
    const count = await summaryEntries();

    const response = await readThroughTheListener();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(await summaryEntries()).toBe(count + 1);

    const written = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "INSTANCE_SUMMARY_READ", channel: "MANAGEMENT" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(written).toMatchObject({
      channel: "MANAGEMENT",
      actorPersonId: null,
      targetPersonId: null,
      targetKind: null,
      targetId: null,
      context: { schema: 1 },
    });
  });

  it("is not written for a refused token", async () => {
    const count = await summaryEntries();

    const response = await readThroughTheListener("not-the-management-token");

    expect(response.statusCode).toBe(401);
    expect(await summaryEntries()).toBe(count);
  });

  it("is not written when the read fails part way", async () => {
    // The document and its entry share one transaction: a read that fails
    // after the counts writes nothing, so the log never says the host was
    // told something it was not.
    const count = await summaryEntries();
    const loader = app.get(PluginLoaderService);
    const failing = vi.spyOn(loader, "report").mockImplementation(() => {
      throw new Error("the loader is gone");
    });
    try {
      await expect(summaries.read()).rejects.toThrow("the loader is gone");
    } finally {
      failing.mockRestore();
    }

    expect(await summaryEntries()).toBe(count);
  });
});

describe("what the document can carry", () => {
  /** Every key the document declares, as a path. */
  const DECLARED = [
    "schema",
    "version",
    "revision",
    "migrations.shipped",
    "migrations.applied",
    "migrations.failed",
    "migrations.pending",
    "migrations.latest",
    "claimed",
    "apartments",
    "register.persons",
    "register.members",
    "register.residents",
    "register.boardSeats",
    "register.administrators",
    "invitedResidents",
    "boardActivityOn",
    "registerExtracts.memberRegister",
    "registerExtracts.apartmentRegister",
    "storage.storedFileBytes",
    "storage.databaseBytes",
    "health.database",
    "health.pluginFindings",
  ].sort();

  /** The only strings it may hold, by where they may appear. */
  const STRINGS: Record<string, RegExp> = {
    version: /^\d+\.\d+\.\d+$/,
    revision: /^[0-9a-f]{7,64}$/,
    "migrations.latest": /^\d{14}_[a-z0-9_]+$/,
    boardActivityOn: /^\d{4}-\d{2}-\d{2}$/,
    "health.database": /^ok$/,
  };

  function leaves(value: unknown, path: string[] = []): [string, unknown][] {
    if (value !== null && typeof value === "object") {
      expect(Array.isArray(value), path.join(".")).toBe(false);
      return Object.entries(value).flatMap(([key, inner]) =>
        leaves(inner, [...path, key]),
      );
    }
    return [[path.join("."), value]];
  }

  it("holds the declared keys, and only counts, flags, versions and a day", async () => {
    const response = await readThroughTheListener();
    expect(response.statusCode, response.body).toBe(200);

    const found = leaves(response.json());

    expect(found.map(([path]) => path).sort()).toEqual(DECLARED);
    for (const [path, value] of found) {
      if (value === null || typeof value === "boolean") {
        continue;
      }
      if (typeof value === "number") {
        expect(Number.isInteger(value) && value >= 0, path).toBe(true);
        continue;
      }
      expect(typeof value, path).toBe("string");
      const pattern = STRINGS[path];
      expect(pattern, `${path} may not hold a string`).toBeDefined();
      expect(value, path).toMatch(pattern!);
    }
  });
});

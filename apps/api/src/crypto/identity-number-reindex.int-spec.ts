import { PrismaPg } from "@prisma/adapter-pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import type { JobQueueService } from "../jobs/job-queue.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { FieldEncryptionService } from "./field-encryption.service";
import { IdentityNumberReindexService } from "./identity-number-reindex.service";
import { NORMALIZATION_VERSION } from "./personal-data";

/**
 * Rewriting the blind indexes an older normalization left behind.
 *
 * What matters is the lookup afterwards: a number stored with an index computed
 * under the old rule has to be found by the index a search computes now, and a
 * number the current rule refuses must stay stored as it was rather than stop
 * anything.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaClient;
let encryption: FieldEncryptionService;
let reindexer: IdentityNumberReindexService;

const suffix = process.hrtime.bigint().toString(36);
const ids = {
  outdated: `reindex-outdated-${suffix}`,
  unreadable: `reindex-unreadable-${suffix}`,
  current: `reindex-current-${suffix}`,
  centenarian: `reindex-centenarian-${suffix}`,
};

/** Twelve digits with a century no living person was born in. */
const UNREADABLE = "258001011231";

async function createPerson(
  id: string,
  number: string,
  index: string,
  version: number,
  createdAt = new Date("2026-03-01T12:00:00Z"),
): Promise<string> {
  const { cipher } = await encryption.encrypt(
    "person.personalIdentityNumber",
    number,
  );
  await prisma.person.create({
    data: {
      id,
      firstName: "Index",
      lastName: suffix,
      personalIdentityNumberCipher: cipher,
      personalIdentityNumberIndex: index,
      personalIdentityNumberIndexVersion: version,
      createdAt,
    },
  });
  return cipher;
}

beforeAll(() => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  encryption = new FieldEncryptionService(env);
  reindexer = new IdentityNumberReindexService(
    env,
    prisma as unknown as PrismaService,
    encryption,
    {} as JobQueueService,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.person.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.$disconnect();
});

describe("rewriting outdated identity number indexes", () => {
  it("gives one number one index, however its century was written", async () => {
    // Under the old rule, between 1 January and 15 December 2026 the short
    // form was read as a person born in December 2026.
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-09-29T12:00:00Z"),
    });
    expect(
      await encryption.computeIndex(
        "person.personalIdentityNumber",
        "261215-1239",
      ),
    ).toBe(
      await encryption.computeIndex(
        "person.personalIdentityNumber",
        "19261215-1239",
      ),
    );
  });

  it("makes a number stored under the old rule findable by today's lookup", async () => {
    await createPerson(ids.outdated, "261215-1239", "index-from-old-rule", 1);
    const unreadableCipher = await createPerson(
      ids.unreadable,
      UNREADABLE,
      "index-from-old-rule",
      1,
    );
    await createPerson(ids.current, "811228-9874", "left-alone", 2);

    const result = await reindexer.reindex();
    expect(result.reindexed).toBeGreaterThanOrEqual(2);
    expect(result.unreadable).toBeGreaterThanOrEqual(1);

    const lookup = await encryption.computeIndex(
      "person.personalIdentityNumber",
      "19261215-1239",
    );
    const found = await prisma.person.findMany({
      where: { personalIdentityNumberIndex: lookup, lastName: suffix },
      select: { id: true, personalIdentityNumberIndexVersion: true },
    });
    expect(found).toEqual([
      {
        id: ids.outdated,
        personalIdentityNumberIndexVersion: NORMALIZATION_VERSION,
      },
    ]);

    // Kept exactly as stored: the number is still there to be revealed, and
    // nothing refuses the person for it. No search can reach it, which is
    // also true of the index it had.
    const unreadable = await prisma.person.findUniqueOrThrow({
      where: { id: ids.unreadable },
      select: {
        personalIdentityNumberCipher: true,
        personalIdentityNumberIndex: true,
        personalIdentityNumberIndexVersion: true,
      },
    });
    expect(unreadable).toEqual({
      personalIdentityNumberCipher: unreadableCipher,
      personalIdentityNumberIndex: null,
      personalIdentityNumberIndexVersion: NORMALIZATION_VERSION,
    });
    expect(
      await encryption.decrypt(
        "person.personalIdentityNumber",
        unreadable.personalIdentityNumberCipher ?? "",
      ),
    ).toBe(UNREADABLE);

    // Already current, so not touched.
    const current = await prisma.person.findUniqueOrThrow({
      where: { id: ids.current },
      select: { personalIdentityNumberIndex: true },
    });
    expect(current.personalIdentityNumberIndex).toBe("left-alone");
  }, 60_000);

  it("dates a number by the day the person was entered, not by today", async () => {
    // Entered in 2000 for a person born in 1925, under the old rule, which
    // read it correctly then. Read as of today it would be a person born in
    // 2025.
    const writtenIn2000 = await encryption.computeIndex(
      "person.personalIdentityNumber",
      "19250101-1231",
    );
    await createPerson(
      ids.centenarian,
      "250101-1231",
      writtenIn2000 ?? "",
      1,
      new Date("2000-06-01T12:00:00Z"),
    );

    await reindexer.reindex();

    const found = await prisma.person.findMany({
      where: { personalIdentityNumberIndex: writtenIn2000, lastName: suffix },
      select: { id: true },
    });
    expect(found).toEqual([{ id: ids.centenarian }]);
  }, 60_000);

  it("finds nothing left to do the second time", async () => {
    // Only this suite's rows: the table is shared, and another suite or run
    // may be inserting rows of its own at an older version meanwhile.
    const mine = { id: { in: Object.values(ids) } };
    const before = await prisma.person.findMany({
      where: mine,
      select: { id: true, personalIdentityNumberIndex: true },
      orderBy: { id: "asc" },
    });

    await reindexer.reindex();

    expect(
      await prisma.person.count({
        where: {
          ...mine,
          personalIdentityNumberIndexVersion: { lt: NORMALIZATION_VERSION },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.person.findMany({
        where: mine,
        select: { id: true, personalIdentityNumberIndex: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });
});

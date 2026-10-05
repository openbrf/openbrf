import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { NORMALIZATION_VERSION } from "../crypto/personal-data";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import type { JobQueueService } from "../jobs/job-queue.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { PersonReindexService } from "./person-reindex.service";

/**
 * A person indexed under older normalisation rules is found again once the
 * instance has started.
 *
 * Asserted against the real column and the real encryption, with the stale
 * index written the way an older release left it: a value nothing computes
 * today. What has to hold is that the index afterwards is the one a search
 * computes now, from the value as entered, and that a row already on the
 * current rules is not touched.
 */

const env = loadEnvForIntegrationTests();
const suffix = runSuffix();
const STALE = `reindex-stale-${suffix}`;
const CURRENT = `reindex-current-${suffix}`;
const NO_PHONE = `reindex-no-phone-${suffix}`;
const PHONE = "070-123 45 67";
const IDENTITY_NUMBER = "19811228-9874";

let prisma: PrismaClient;
let encryption: FieldEncryptionService;
let service: PersonReindexService;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  encryption = new FieldEncryptionService(env);
  service = new PersonReindexService(
    env,
    prisma as unknown as PrismaService,
    encryption,
    {} as JobQueueService,
  );

  const phone = await encryption.encrypt("person.phone", PHONE);
  const number = await encryption.encrypt(
    "person.personalIdentityNumber",
    IDENTITY_NUMBER,
  );
  const stale = {
    phoneCipher: phone.cipher,
    phoneIndex: "stale",
    personalIdentityNumberCipher: number.cipher,
    personalIdentityNumberIndex: "stale",
  };
  await prisma.person.createMany({
    data: [
      {
        id: STALE,
        firstName: "Anna",
        lastName: "Lindqvist",
        ...stale,
        blindIndexVersion: 1,
      },
      {
        id: CURRENT,
        firstName: "Erik",
        lastName: "Lindqvist",
        ...stale,
        blindIndexVersion: NORMALIZATION_VERSION,
      },
      {
        id: NO_PHONE,
        firstName: "Sara",
        lastName: "Berg",
        blindIndexVersion: 1,
      },
    ],
  });
});

afterAll(async () => {
  await prisma.person.deleteMany({
    where: { id: { in: [STALE, CURRENT, NO_PHONE] } },
  });
  await prisma.$disconnect();
});

describe("reindexing people at boot", () => {
  it("recomputes a stale row's indexes from what was entered", async () => {
    await service.run();

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: STALE },
    });
    expect(person.phoneIndex).toBe(
      await encryption.computeIndex("person.phone", PHONE),
    );
    expect(person.personalIdentityNumberIndex).toBe(
      await encryption.computeIndex(
        "person.personalIdentityNumber",
        IDENTITY_NUMBER,
      ),
    );
    expect(person.blindIndexVersion).toBe(NORMALIZATION_VERSION);
  });

  it("leaves a row already on the current rules alone", async () => {
    await service.run();

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: CURRENT },
    });
    expect(person.phoneIndex).toBe("stale");
  });

  it("moves a row with nothing to index to the current version", async () => {
    await service.run();

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: NO_PHONE },
    });
    expect(person).toMatchObject({
      phoneIndex: null,
      personalIdentityNumberIndex: null,
      blindIndexVersion: NORMALIZATION_VERSION,
    });
  });

  it("gives a row written without a version the current one", async () => {
    // The column default, which is what keeps a row the application writes
    // today from being reindexed at the next boot.
    const id = `reindex-default-${suffix}`;
    await prisma.person.create({
      data: { id, firstName: "Karin", lastName: "Öhman" },
    });
    try {
      const person = await prisma.person.findUniqueOrThrow({ where: { id } });
      expect(person.blindIndexVersion).toBe(NORMALIZATION_VERSION);
    } finally {
      await prisma.person.delete({ where: { id } });
    }
  });
});

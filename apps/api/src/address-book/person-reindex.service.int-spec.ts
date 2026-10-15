import { Logger } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { CipherSweet, EncryptedField, StringProvider } from "ciphersweet-js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { AuditLogService } from "../audit/audit-log.service";
import { EncryptionKeyProvider } from "../crypto/encryption-key.provider";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { NORMALIZATION_VERSION } from "../crypto/personal-data";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { ImportPlannerService } from "../import/import-planner.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import {
  advisoryLockCount,
  terminateAdvisoryLockHolder,
  waitFor,
} from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { PersonReindexLock } from "./person-reindex-lock";
import {
  type PersonReindexJob,
  PersonReindexService,
} from "./person-reindex.service";
import { PersonService } from "./person.service";

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
    new PersonReindexLock(env),
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

describe("a number stored without its century", () => {
  // 261201-1235 reads as 1926 until 1 December 2026 and as 2026 from then on.
  const WRITTEN = "261201-1235";
  const WRITTEN_ON = new Date(2026, 2, 15, 12);
  const DAY_OF = new Date(2026, 11, 1, 12);
  const id = `reindex-short-${suffix}`;
  const filledIn = `reindex-filled-in-${suffix}`;
  const flagged = `reindex-flagged-${suffix}`;
  const addressId = `reindex-address-${suffix}`;
  const street = `Omindexgatan ${suffix}`;

  let legacy: EncryptedField;

  beforeAll(async () => {
    // As a release before this one stored it: the value as entered, without
    // its century, in the library's own format. Written with the library
    // directly because the service no longer stores a number this way.
    legacy = new EncryptedField(
      new CipherSweet(new StringProvider(EncryptionKeyProvider.resolve(env))),
      "person",
      "personalIdentityNumber",
    );
    await prisma.person.create({
      data: {
        id,
        firstName: "Greta",
        lastName: "Holm",
        personalIdentityNumberCipher: await legacy.encryptValue(WRITTEN),
        // What that release computed: the year alone, so 2026, a birthday
        // still to come. No reading this one makes can match it.
        personalIdentityNumberIndex: await encryption.computeIndex(
          "person.personalIdentityNumber",
          `20${WRITTEN}`,
        ),
        blindIndexVersion: 1,
        createdAt: WRITTEN_ON,
        updatedAt: WRITTEN_ON,
      },
    });
    await prisma.address.create({
      data: {
        id: addressId,
        street,
        number: "1",
        postalCode: "11122",
        city: "Stockholm",
        sortOrder: 931,
      },
    });
    await prisma.apartment.create({
      data: { id: `reindex-apartment-${suffix}`, addressId, number: "1101" },
    });
  });

  // Some tests freeze the clock; give the next one the real one back
  // even when an assertion throws.
  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.person.deleteMany({
      where: { id: { in: [id, filledIn, flagged] } },
    });
    await prisma.apartment.deleteMany({ where: { addressId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
  });

  it("is read as written, whenever the reindex runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    // First reindexed on the day the digits flip: still the person entered
    // in March, so the ciphertext gains the century they meant then.
    vi.setSystemTime(DAY_OF);
    await service.run();
    const first = await prisma.person.findUniqueOrThrow({ where: { id } });
    await expect(
      encryption.decrypt(
        "person.personalIdentityNumber",
        first.personalIdentityNumberCipher ?? "",
      ),
    ).resolves.toBe(`19${WRITTEN}`);

    // Reindexed again, it stays that person.
    await prisma.person.update({
      where: { id },
      data: { blindIndexVersion: 1 },
    });
    await service.run();
    const again = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(again.personalIdentityNumberIndex).toBe(
      first.personalIdentityNumberIndex,
    );

    // And an import on that day finds them by the number with its century,
    // while the ten digits alone, which now read as a newborn, are refused
    // rather than matched to anyone.
    const plan = await new ImportPlannerService(
      prisma as unknown as PrismaService,
      encryption,
    ).plan({
      rows: [
        [`${street} 1`, "1101", "Greta Holm", `19${WRITTEN}`],
        [`${street} 1`, "1101", "Greta Holm", WRITTEN],
      ],
      columnCount: 4,
      mapping: [
        "addressLabel",
        "apartmentNumber",
        "fullName",
        "personalIdentityNumber",
      ],
      defaultRole: "MEMBER",
      defaultMovedInOn: "2026-01-01",
      indexEveryIdentityNumber: false,
      indexes: new Map(),
    });
    expect(plan.rows[0]).toMatchObject({
      matchedBy: "personalIdentityNumber",
      matchedPersonId: id,
    });
    expect(plan.rows[1]).toMatchObject({
      outcome: "error",
      problems: [
        {
          field: "personalIdentityNumber",
          reason: "personal-identity-number-needs-century",
        },
      ],
    });
  });

  it("is not moved by a change to the person after the birthday", async () => {
    // Entered in March, before its birthday, as 1926; the board then marks
    // the person protected in December, after it. The row's last change is
    // that December day, which reads the digits as 2026, and version 1's
    // index of a birthday still to come said 2026 as well.
    const written = "261115-1230";
    await prisma.person.create({
      data: {
        id: flagged,
        firstName: "Ebba",
        lastName: "Holm",
        personalIdentityNumberCipher: await legacy.encryptValue(written),
        personalIdentityNumberIndex: await encryption.computeIndex(
          "person.personalIdentityNumber",
          `20${written}`,
        ),
        blindIndexVersion: 1,
        createdAt: WRITTEN_ON,
        updatedAt: WRITTEN_ON,
      },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 11, 2, 12));
    await new PersonService(
      prisma as unknown as PrismaService,
      encryption,
      new AuditLogService(prisma as unknown as PrismaService),
    ).setProtectedPersonalData({
      personId: flagged,
      protectedPersonalData: true,
      actorPersonId: flagged,
    });
    expect(
      (await prisma.person.findUniqueOrThrow({ where: { id: flagged } }))
        .updatedAt,
    ).toEqual(new Date(2026, 11, 2, 12));

    await service.run();

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: flagged },
    });
    await expect(
      encryption.decrypt(
        "person.personalIdentityNumber",
        person.personalIdentityNumberCipher ?? "",
      ),
    ).resolves.toBe(`19${written}`);
    expect(person.personalIdentityNumberIndex).toBe(
      await encryption.computeIndex(
        "person.personalIdentityNumber",
        `19${written}`,
      ),
    );
    const plan = await new ImportPlannerService(
      prisma as unknown as PrismaService,
      encryption,
    ).plan({
      rows: [[`${street} 1`, "1101", "Ebba Holm", `19${written}`]],
      columnCount: 4,
      mapping: [
        "addressLabel",
        "apartmentNumber",
        "fullName",
        "personalIdentityNumber",
      ],
      defaultRole: "MEMBER",
      defaultMovedInOn: "2026-01-01",
      indexEveryIdentityNumber: false,
      indexes: new Map(),
    });
    expect(plan.rows[0]).toMatchObject({
      matchedBy: "personalIdentityNumber",
      matchedPersonId: flagged,
    });
  });

  it("takes the century its stored index was given when the number came later", async () => {
    // A person added in 2024 whose number an import filled in this October:
    // 251201-1236 read as 1925 when the row was made, and as 2025 when the
    // number was written, which is the reading its index carries.
    await prisma.person.create({
      data: {
        id: filledIn,
        firstName: "Elsa",
        lastName: "Holm",
        personalIdentityNumberCipher: await legacy.encryptValue("251201-1236"),
        personalIdentityNumberIndex: await encryption.computeIndex(
          "person.personalIdentityNumber",
          "20251201-1236",
        ),
        blindIndexVersion: 1,
        createdAt: new Date(2024, 5, 1, 12),
        updatedAt: new Date(2026, 9, 1, 12),
      },
    });

    await service.run();

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: filledIn },
    });
    await expect(
      encryption.decrypt(
        "person.personalIdentityNumber",
        person.personalIdentityNumberCipher ?? "",
      ),
    ).resolves.toBe("20251201-1236");
  });
});

describe("runs that overlap", () => {
  // Spelled out rather than imported, so a lock that quietly changed its key
  // fails here instead of passing under the new one.
  const LOCK_KEY = "person-reindex:run";
  const id = `reindex-overlap-${suffix}`;
  const db = (): PrismaService => prisma as unknown as PrismaService;

  /** A stale row, as the release before the upgrade left it. */
  async function createStale(): Promise<void> {
    await prisma.person.create({
      data: {
        id,
        firstName: "Ingrid",
        lastName: "Sandberg",
        personalIdentityNumberCipher: (
          await encryption.encrypt(
            "person.personalIdentityNumber",
            IDENTITY_NUMBER,
          )
        ).cipher,
        personalIdentityNumberIndex: "stale",
        blindIndexVersion: 1,
      },
    });
  }

  /**
   * A run on an instance of its own: its own lock, and an encryption that
   * holds the run between a row's hash and its write until released.
   */
  function instance(): {
    service: PersonReindexService;
    sendAt: ReturnType<typeof vi.fn>;
    encrypted: ReturnType<typeof vi.fn>;
    midRow: Promise<void>;
    release: () => void;
  } {
    const own = new FieldEncryptionService(env);
    const encrypt = own.encrypt.bind(own);
    let computed!: () => void;
    const midRow = new Promise<void>((resolve) => {
      computed = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypted = vi.fn(async (field: string, value: string) => {
      const result = await encrypt(
        field as Parameters<typeof encrypt>[0],
        value,
      );
      computed();
      await held;
      return result;
    });
    own.encrypt = encrypted as unknown as typeof own.encrypt;
    const sendAt = vi.fn(() => Promise.resolve());
    return {
      service: new PersonReindexService(
        env,
        prisma as unknown as PrismaService,
        own,
        { sendAt } as unknown as JobQueueService,
        new PersonReindexLock(env),
      ),
      sendAt,
      encrypted,
      midRow,
      release,
    };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.person.deleteMany({ where: { id } });
  });

  it("lets one run at a time walk the register, at boot and on recovery", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await createStale();
    const first = instance();
    const running = first.service.runJob();
    await first.midRow;
    expect(await advisoryLockCount(db(), LOCK_KEY, true)).toBe(1n);

    // Another instance's boot, and a run queued after an earlier failure,
    // arrive while the first run is part way through a row.
    const boot = instance();
    const recovery = instance();
    await boot.service.runJob();
    await recovery.service.runJob({
      failingSince: new Date().toISOString(),
      failures: 2,
    } satisfies PersonReindexJob);

    // Neither read a row, and neither queued a run of its own.
    for (const other of [boot, recovery]) {
      expect(other.encrypted).not.toHaveBeenCalled();
      expect(other.sendAt).not.toHaveBeenCalled();
    }
    expect(await advisoryLockCount(db(), LOCK_KEY, true)).toBe(1n);

    first.release();
    await running;
    expect(first.sendAt).not.toHaveBeenCalled();
    const person = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(person.blindIndexVersion).toBe(NORMALIZATION_VERSION);
    // Closing the session let the lock go.
    expect(await advisoryLockCount(db(), LOCK_KEY, true)).toBe(0n);
  }, 30_000);

  it("stops before its next write when its lock is lost, and the next run finishes", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    await createStale();
    const first = instance();
    const running = first.service.runJob();
    await first.midRow;

    // The session holding the lock ends while the run is part way through a
    // row: the database hands the lock to whoever asks next.
    expect(await terminateAdvisoryLockHolder(db(), LOCK_KEY)).toBe(1);
    await waitFor(
      async () => (await advisoryLockCount(db(), LOCK_KEY, true)) === 0n,
    );
    first.release();
    await running;

    // The row was not written by a run that no longer held the lock.
    const stale = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(stale.blindIndexVersion).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("PersonReindexLockLostError"),
    );
    expect(first.sendAt).toHaveBeenCalledOnce();
    const [, job] = first.sendAt.mock.lastCall as [string, PersonReindexJob];

    // The run it queued takes the lock and finishes.
    const next = instance();
    next.release();
    await next.service.runJob(job);
    expect(next.sendAt).not.toHaveBeenCalled();
    const person = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(person.blindIndexVersion).toBe(NORMALIZATION_VERSION);
  }, 30_000);
});

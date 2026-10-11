import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import { normalizePersonalIdentityNumber } from "../crypto/personal-data";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { PersonReindexLock } from "./person-reindex-lock";
import {
  type PersonReindexJob,
  PersonReindexService,
} from "./person-reindex.service";

/**
 * Which century the reindex gives a version-1 number stored without one, from
 * the days its row records and the index stored beside it.
 *
 * The encryption is a stand-in that stores values in the clear and indexes the
 * normalised value, so what is asserted is the reading chosen, not the
 * cryptography; person-reindex.service.int-spec.ts covers that.
 */

interface Row {
  id: string;
  phoneCipher: string | null;
  personalIdentityNumberCipher: string | null;
  personalIdentityNumberIndex: string | null;
  blindIndexVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const encryption = {
  decrypt: (_id: string, cipher: string) => Promise.resolve(cipher),
  computeIndex: (_id: string, value: string) =>
    Promise.resolve(`index:${normalizePersonalIdentityNumber(value) ?? value}`),
  encrypt: async (id: string, value: string) => ({
    cipher: value,
    index: await encryption.computeIndex(id, value),
  }),
};

/** Reindexes one version-1 row and answers the number it was given. */
async function reindex(input: {
  written: string;
  /** What version 1 indexed the number as. */
  indexedAs: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Promise<string | null> {
  const row: Row = {
    id: "person",
    phoneCipher: null,
    personalIdentityNumberCipher: input.written,
    personalIdentityNumberIndex:
      input.indexedAs === null
        ? null
        : await encryption.computeIndex("", input.indexedAs),
    blindIndexVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  const person = {
    findMany: () =>
      Promise.resolve(row.blindIndexVersion < 2 ? [{ ...row }] : []),
    updateMany: ({ data }: { data: Partial<Row> }) => {
      Object.assign(row, data);
      return Promise.resolve({ count: 1 });
    },
  };
  const tx = { person, $executeRaw: () => Promise.resolve(0) };
  const prisma = {
    person,
    $transaction: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
  };
  await new PersonReindexService(
    { NODE_ENV: "test" } as Env,
    prisma as unknown as PrismaService,
    encryption as unknown as FieldEncryptionService,
    {} as JobQueueService,
    {} as PersonReindexLock,
  ).run();
  return row.personalIdentityNumberCipher;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the century a version-1 number is given", () => {
  it("is the one of the day the row was made, whatever changed it since", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await expect(
      reindex({
        written: "261201-1235",
        indexedAs: "20261201-1235",
        createdAt: new Date(2026, 2, 15, 12),
        updatedAt: new Date(2026, 11, 2, 12),
      }),
    ).resolves.toBe("19261201-1235");
    // The December change could have been the number's own, so it is said.
    expect(warn).toHaveBeenCalledOnce();
  });

  it("is the one its index shows when the number came later", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    // Indexed as 2025, so written in 2025, and by November: a birthday on
    // 1 December still to come, so 1925.
    await expect(
      reindex({
        written: "251201-1236",
        indexedAs: "20251201-1236",
        createdAt: new Date(2024, 5, 1, 12),
        updatedAt: new Date(2025, 10, 1, 12),
      }),
    ).resolves.toBe("19251201-1236");
    expect(warn).not.toHaveBeenCalled();
  });

  it("is the one of the day the row was made when its index says that year", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await expect(
      reindex({
        written: "251201-1236",
        indexedAs: "19251201-1236",
        createdAt: new Date(2024, 5, 1, 12),
        updatedAt: new Date(2026, 9, 1, 12),
      }),
    ).resolves.toBe("19251201-1236");
    expect(warn).not.toHaveBeenCalled();
  });

  it("follows the year a person turns 100 for a number written with a plus", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await expect(
      reindex({
        written: "251201+1236",
        indexedAs: "19251201+1236",
        createdAt: new Date(2024, 5, 1, 12),
        updatedAt: new Date(2025, 5, 1, 12),
      }),
    ).resolves.toBe("19251201+1236");
    expect(warn).not.toHaveBeenCalled();
  });
});

/** A lock no other run holds. */
const free = {
  whileHeld: async (work: (lost: AbortSignal) => Promise<void>) => {
    await work(new AbortController().signal);
    return true;
  },
} as unknown as PersonReindexLock;

/** The lock wait run out, as a chunk holding the number for longer makes it. */
function lockTimeout(): Error {
  return Object.assign(new Error("canceling statement due to lock timeout"), {
    code: "55P03",
  });
}

/**
 * A register of version-1 rows without phone numbers, whose writes answer as
 * `write` says: a failure, or the row written.
 */
function register(
  ids: readonly string[],
  write: (id: string) => Error | null,
  decrypt: (cipher: string) => Promise<string> = (cipher) =>
    Promise.resolve(cipher),
) {
  const stale = new Set(ids);
  const person = {
    findMany: () =>
      Promise.resolve(
        [...stale].map((id) => ({
          id,
          phoneCipher: null,
          personalIdentityNumberCipher: "19811228-9874",
          personalIdentityNumberIndex: null,
          createdAt: new Date(2020, 0, 1),
          updatedAt: new Date(2020, 0, 1),
        })),
      ),
    updateMany: vi.fn(({ where }: { where: { id: string } }) => {
      stale.delete(where.id);
      return Promise.resolve({ count: 1 });
    }),
  };
  const tx = { person, $executeRaw: () => Promise.resolve(0) };
  const prisma = {
    person,
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => {
      // The id of the row this transaction writes: the only one findMany
      // gives that is still to be written, first in order.
      const [id = ""] = stale;
      const failure = write(id);
      if (failure !== null) {
        throw failure;
      }
      return work(tx);
    },
  };
  return {
    stale,
    updateMany: person.updateMany,
    prisma: prisma as unknown as PrismaService,
    encryption: {
      ...encryption,
      decrypt: (_id: string, cipher: string) => decrypt(cipher),
    } as unknown as FieldEncryptionService,
  };
}

/** The payload and time of the run a failed one queued. */
function queuedRun(sendAt: ReturnType<typeof vi.fn>): {
  job: PersonReindexJob;
  runAt: Date;
} {
  const [queue, job, runAt] = sendAt.mock.lastCall as [
    string,
    PersonReindexJob,
    Date,
  ];
  expect(queue).toBe("person-blind-index-reindex");
  return { job, runAt };
}

describe("a run that does not finish", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues the next one for a minute later", async () => {
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const sendAt = vi.fn(() => Promise.resolve());
    const { prisma, encryption } = register(["person"], lockTimeout);
    const before = Date.now();

    await new PersonReindexService(
      { NODE_ENV: "test" } as Env,
      prisma,
      encryption,
      { sendAt } as unknown as JobQueueService,
      free,
    ).runJob();

    expect(sendAt).toHaveBeenCalledOnce();
    const { job, runAt } = queuedRun(sendAt);
    expect(runAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    // The first failure, and when it was.
    expect(job.failures).toBe(1);
    expect(new Date(job.failingSince ?? "").getTime()).toBeGreaterThanOrEqual(
      before,
    );
    // Named by its class and code, and by nothing it was holding.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Error (55P03)"),
    );
  });

  it("gives up once runs have failed for an hour without writing a row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 11, 12));
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const sendAt = vi.fn(() => Promise.resolve());
    const { prisma, encryption } = register(["person"], lockTimeout);
    const service = new PersonReindexService(
      { NODE_ENV: "test" } as Env,
      prisma,
      encryption,
      { sendAt } as unknown as JobQueueService,
      free,
    );

    // Each run starts when the one before it queued it, as the queue would
    // start it, and carries what that one queued.
    let job: PersonReindexJob = {};
    let runs = 0;
    const firstFailure = Date.now();
    for (; runs < 100; runs++) {
      const queued = sendAt.mock.calls.length;
      await service.runJob(job);
      if (sendAt.mock.calls.length === queued) {
        break;
      }
      const next = queuedRun(sendAt);
      // The time the failures began, whichever run this is.
      expect(next.job.failingSince).toBe(new Date(firstFailure).toISOString());
      job = next.job;
      vi.setSystemTime(next.runAt);
    }

    // A run a minute for the hour, and then no more.
    expect(runs).toBe(60);
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining("Reindex gave up after 61 runs"),
    );
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining("restart the instance"),
    );
  });

  it("finishes once the contention clears within the hour", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const sendAt = vi.fn(() => Promise.resolve());
    let contended = 3;
    const { prisma, encryption, stale } = register(["person"], () =>
      contended-- > 0 ? lockTimeout() : null,
    );
    const service = new PersonReindexService(
      { NODE_ENV: "test" } as Env,
      prisma,
      encryption,
      { sendAt } as unknown as JobQueueService,
      free,
    );

    let job: PersonReindexJob = {};
    for (let run = 0; run < 3; run++) {
      await service.runJob(job);
      job = queuedRun(sendAt).job;
    }
    expect(job.failures).toBe(3);
    await service.runJob(job);

    expect(stale.size).toBe(0);
    expect(sendAt).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("gave up"));
  });

  it("starts the hour again after a run that wrote rows before it failed", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const sendAt = vi.fn(() => Promise.resolve());
    const { prisma, encryption, stale } = register(["first", "second"], (id) =>
      id === "second" ? lockTimeout() : null,
    );
    const before = Date.now();

    await new PersonReindexService(
      { NODE_ENV: "test" } as Env,
      prisma,
      encryption,
      { sendAt } as unknown as JobQueueService,
      free,
    ).runJob({
      failingSince: new Date(before - 59 * 60_000).toISOString(),
      failures: 59,
    });

    expect([...stale]).toEqual(["second"]);
    const { job } = queuedRun(sendAt);
    expect(job.failures).toBe(1);
    expect(new Date(job.failingSince ?? "").getTime()).toBeGreaterThanOrEqual(
      before,
    );
  });

  it("gives up at once on a value it cannot decrypt", async () => {
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const sendAt = vi.fn(() => Promise.resolve());
    const { prisma, encryption, updateMany } = register(
      ["damaged"],
      () => null,
      () => Promise.reject(new Error("Invalid MAC")),
    );

    await new PersonReindexService(
      { NODE_ENV: "test" } as Env,
      prisma,
      encryption,
      { sendAt } as unknown as JobQueueService,
      free,
    ).runJob();

    expect(sendAt).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    // The person is named by their id, so somebody can look at the row.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "person damaged's person.personalIdentityNumber cannot be decrypted",
      ),
    );
  });
});

describe("runs on several instances", () => {
  it("leave the rows to the run that holds the lock", async () => {
    const log = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    const sendAt = vi.fn(() => Promise.resolve());
    const { prisma, encryption, updateMany } = register(["person"], () => null);
    const held = {
      whileHeld: () => Promise.resolve(false),
    } as unknown as PersonReindexLock;

    await new PersonReindexService(
      { NODE_ENV: "test" } as Env,
      prisma,
      encryption,
      { sendAt } as unknown as JobQueueService,
      held,
    ).runJob({ failingSince: new Date().toISOString(), failures: 3 });

    // Neither a write nor a run of its own queued: the holder answers for both.
    expect(updateMany).not.toHaveBeenCalled();
    expect(sendAt).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("already under way"),
    );
  });

  it("stop before the next write when the lock is lost, and queue the next run", async () => {
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const sendAt = vi.fn(() => Promise.resolve());
    const { prisma, encryption, updateMany } = register(["person"], () => null);
    const lost = {
      whileHeld: async (work: (lost: AbortSignal) => Promise<void>) => {
        const controller = new AbortController();
        controller.abort(
          Object.assign(new Error("lost"), {
            name: "PersonReindexLockLostError",
          }),
        );
        await work(controller.signal);
        return true;
      },
    } as unknown as PersonReindexLock;

    await new PersonReindexService(
      { NODE_ENV: "test" } as Env,
      prisma,
      encryption,
      { sendAt } as unknown as JobQueueService,
      lost,
    ).runJob();

    expect(updateMany).not.toHaveBeenCalled();
    expect(sendAt).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("PersonReindexLockLostError"),
    );
  });
});

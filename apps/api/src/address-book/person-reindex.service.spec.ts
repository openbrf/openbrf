import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import { normalizePersonalIdentityNumber } from "../crypto/personal-data";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { PersonReindexService } from "./person-reindex.service";

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
  const prisma = {
    person: {
      findMany: () =>
        Promise.resolve(row.blindIndexVersion < 2 ? [{ ...row }] : []),
      updateMany: ({ data }: { data: Partial<Row> }) => {
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
    },
  };
  await new PersonReindexService(
    { NODE_ENV: "test" } as Env,
    prisma as unknown as PrismaService,
    encryption as unknown as FieldEncryptionService,
    {} as JobQueueService,
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

import {
  PLUGIN_RECORD_LIMITS,
  type PluginPersonRecordCollection,
  PluginRecordLimitError,
} from "@openbrf/plugin-sdk";
import { addLocalDays, formatLocalDay, localDayOf } from "@openbrf/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { PluginPersonRecordsService } from "./plugin-person-records.service";
import { PluginRecordsService } from "./plugin-records.service";

/**
 * How `host.personRecords` waits its turn in the write queue it shares with
 * `host.records` (ADR 0047).
 *
 * The store itself, who a record may name and what a hold keeps are in
 * `plugin-person-records.int-spec.ts`; this is the queue, which needs a
 * database that can be held still to answer.
 */

const CLAIMS: PluginPersonRecordCollection = {
  collection: "claims",
  titleKey: "records.claims.title",
  personalData: ["apartment"],
  keepAtMostDays: 730,
  fields: [],
};

describe("a write about a person waiting its turn", () => {
  /**
   * A database whose lookups of a person wait until `open` is called, behind
   * a client that refuses everything outside a write's transaction.
   */
  function gatedStore() {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let lookups = 0;
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        if (sql.join("").includes("FROM person")) {
          lookups += 1;
          await gate;
          return [];
        }
        return [1];
      },
      $executeRaw: async () => 1,
      pluginRecord: {
        findFirst: async () => null,
        aggregate: async () => ({ _count: { _all: 0 }, _sum: { size: 0 } }),
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          eraseOn: null,
          revision: 1,
          updatedAt: new Date(0),
        }),
      },
    };
    const outside = (): never => {
      throw new Error("Asked the database outside a write's turn.");
    };
    const prisma = {
      $queryRaw: outside,
      $executeRaw: outside,
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) =>
        await run(tx),
    };
    const addressBook = {
      isListed: async () => true,
      withheldFrom: async () => new Set<string>(),
    };
    const service = new PluginPersonRecordsService(
      prisma as never,
      new PluginRecordsService(prisma as never),
      addressBook as never,
    );
    return { service, open, lookups: () => lookups };
  }

  const claim = {
    subject: "resident-1",
    eraseOn: formatLocalDay(addLocalDays(localDayOf(new Date()), 30)),
    // Both shaped as a person id, so the write asks whether either is one.
    value: { status: "confirmed" },
  };

  it("asks after the persons it names in its turn, and is refused past the queue's limit", async () => {
    const { service, open, lookups } = gatedStore();
    const cap = PLUGIN_RECORD_LIMITS.queuedWrites;
    const queued = Array.from({ length: cap }, (_, index) =>
      service.put("parking", [CLAIMS], "claims", `k${String(index)}`, claim),
    );
    const refused = await Promise.all(
      Array.from({ length: cap }, () =>
        service
          .put("parking", [CLAIMS], "claims", "over", claim)
          .catch((error: unknown) => error),
      ),
    );

    for (const error of refused) {
      expect(error).toBeInstanceOf(PluginRecordLimitError);
      expect(error).toMatchObject({ limit: "queuedWrites" });
    }
    // One lookup under way however many writes wait for it.
    await vi.waitFor(() => {
      expect(lookups()).toBe(1);
    });

    open();
    await expect(Promise.all(queued)).resolves.toHaveLength(cap);
    expect(lookups()).toBe(cap);
  });
});

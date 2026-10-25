import {
  PLUGIN_RECORD_LIMITS,
  PluginRecordLimitError,
  PluginRecordOtherPersonError,
  type PluginPersonRecordCollection,
} from "@openbrf/plugin-sdk";
import { addLocalDays, formatLocalDay, localDayOf } from "@openbrf/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  personIdCandidates,
  PluginPersonRecordsService,
} from "./plugin-person-records.service";
import { PluginRecordsService } from "./plugin-records.service";

const ID = "cmh2x7q0a0000abcd1234efgh";

describe("personIdCandidates", () => {
  it("finds an id in the key, a property name and a string at any depth", () => {
    for (const [key, value] of [
      [ID, {}],
      [`offer:${ID}`, {}],
      ["k", { [ID]: 1 }],
      ["k", { holder: ID }],
      ["k", { notes: [{ by: [`by ${ID}.`] }] }],
    ] as const) {
      expect(personIdCandidates(key, value), JSON.stringify(value)).toContain(
        ID,
      );
    }
  });

  it("finds an id of letters and digits joined to a word with - or _", () => {
    expect(personIdCandidates("k", { a: `holder-${ID}` })).toContain(ID);
    expect(personIdCandidates("k", { a: `holder_${ID}` })).toContain(ID);
  });

  it("keeps an id holding - or _ whole where it is set off", () => {
    expect(personIdCandidates("k", { a: "offer:seed-person-anna." })).toContain(
      "seed-person-anna",
    );
  });

  it("leaves out numbers, runs longer than an id can be, and duplicates", () => {
    const long = "a".repeat(65);
    const found = personIdCandidates("k", { a: 12, b: long, c: [ID, ID] });
    expect(found).not.toContain(long);
    expect(found).not.toContain("12");
    expect(found.filter((candidate) => candidate === ID)).toHaveLength(1);
  });
});

describe("writes about a person waiting their turn", () => {
  const CLAIMS: PluginPersonRecordCollection = {
    collection: "claims",
    titleKey: "records.claims.title",
    personalData: ["apartment"],
    keepAtMostDays: 730,
    fields: [],
  };

  /**
   * A database whose transactions all wait until `open` is called, in which
   * every value names a person other than its subject.
   */
  function gatedStore() {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const counts = { started: 0, outside: 0, lookups: 0, mostAtOnce: 0 };
    let looking = 0;
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        if (!sql.join("").includes("FROM person")) {
          // The plugin's installed row, which `lockPlugin` finds.
          return [1];
        }
        counts.lookups += 1;
        looking += 1;
        counts.mostAtOnce = Math.max(counts.mostAtOnce, looking);
        await new Promise((resolve) => setTimeout(resolve, 0));
        looking -= 1;
        return [1];
      },
    };
    const prisma = {
      $queryRaw: async () => {
        counts.outside += 1;
        await gate;
        return [1];
      },
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => {
        counts.started += 1;
        await gate;
        return await run(tx);
      },
    };
    const records = new PluginRecordsService(prisma as never);
    return {
      service: new PluginPersonRecordsService(
        prisma as never,
        records,
        {} as never,
      ),
      open,
      counts,
    };
  }

  it("look for another person's id in their turn, held to the queue's number", async () => {
    const { service, open, counts } = gatedStore();
    const cap = PLUGIN_RECORD_LIMITS.queuedWrites;
    const eraseOn = formatLocalDay(addLocalDays(localDayOf(new Date()), 30));
    const settled = Array.from({ length: cap * 2 }, (_, index) =>
      service
        .put("parking", [CLAIMS], "claims", `k${String(index)}`, {
          subject: "seed-person-anna",
          eraseOn,
          value: { holder: ID },
        })
        .catch((error: unknown) => error),
    );
    const outcomes: unknown[] = [];
    for (const outcome of settled) {
      void outcome.then((value) => outcomes.push(value));
    }

    // The writes past the queue's number are refused while the line waits,
    // before any of them asks the database anything.
    await vi.waitFor(() => {
      expect(
        outcomes.filter((outcome) => outcome instanceof PluginRecordLimitError),
      ).toHaveLength(cap);
    });
    expect(counts).toMatchObject({ started: 1, outside: 0, lookups: 0 });

    open();
    const all = await Promise.all(settled);
    expect(
      all.filter((outcome) => outcome instanceof PluginRecordOtherPersonError),
    ).toHaveLength(cap);
    // One lookup for each write the queue took, one at a time.
    expect(counts).toMatchObject({ outside: 0, lookups: cap, mostAtOnce: 1 });
  });
});

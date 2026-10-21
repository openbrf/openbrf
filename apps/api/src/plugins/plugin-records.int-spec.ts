import {
  type JsonValue,
  PLUGIN_RECORD_LIMITS,
  PluginHostUnavailableError,
  PluginRecordConflictError,
  PluginRecordLimitError,
} from "@openbrf/plugin-sdk";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { PluginRecordsService } from "./plugin-records.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { PluginPackageChangedError } from "./plugin.errors";

/**
 * A plugin's own records against a real database (ADR 0033).
 *
 * What only the database can show: that a compare-and-set holds when two
 * writes arrive together, that the limits count what is stored, that `list`
 * pages in key order, that one plugin never reads another's records, that a
 * burst of one plugin's writes holds one connection rather than the pool, that
 * removing a plugin takes its records with its row, and that another package
 * cannot take them over under the same id.
 */

const env = loadEnvForIntegrationTests();
const suffix = runSuffix();
const PLUGIN = `records-${suffix}`.toLowerCase();
const OTHER = `records-other-${suffix}`.toLowerCase();

let prisma: PrismaService;
let registry: PluginRegistryService;
let records: PluginRecordsService;

async function install(
  id: string,
  { packageName = `@example/${id}`, version = "1.0.0" } = {},
): Promise<void> {
  await registry.consent({
    id,
    packageName,
    version,
    tarballUrl: "",
    checksum: "sha512-test",
    permissions: [],
    personalData: [],
    actions: [],
    ai: false,
  });
}

beforeAll(async () => {
  prisma = new PrismaService(env);
  await prisma.$connect();
  registry = new PluginRegistryService(prisma);
  records = new PluginRecordsService(prisma);
});

beforeEach(async () => {
  await prisma.installedPlugin.deleteMany({
    where: { id: { in: [PLUGIN, OTHER] } },
  });
  await install(PLUGIN);
  await install(OTHER);
});

afterAll(async () => {
  await prisma.installedPlugin.deleteMany({
    where: { id: { in: [PLUGIN, OTHER] } },
  });
  await prisma.$disconnect();
});

describe("writing and reading", () => {
  it("keeps a value and counts its revisions", async () => {
    const first = await records.put(PLUGIN, "screens", "hall", {
      name: "Entrén",
      rotation: 10,
    });
    expect(first).toMatchObject({
      collection: "screens",
      key: "hall",
      value: { name: "Entrén", rotation: 10 },
      revision: 1,
    });
    expect(Number.isNaN(Date.parse(first.updatedAt))).toBe(false);

    const second = await records.put(PLUGIN, "screens", "hall", {
      rotation: 12,
    });
    expect(second.revision).toBe(2);
    await expect(records.get(PLUGIN, "screens", "hall")).resolves.toEqual(
      second,
    );
  });

  it("keeps null, an array and a string as the whole value", async () => {
    for (const value of [null, [1, "två", { tre: true }], "text"]) {
      const written = await records.put(PLUGIN, "values", "one", value);
      expect(written.value).toEqual(value);
      expect((await records.get(PLUGIN, "values", "one"))?.value).toEqual(
        value,
      );
    }
  });

  it("keeps property names Object.prototype has too, and refuses __proto__", async () => {
    // The host stores its own copy of the value, built by assignment, and the
    // database client serialises that copy: a name either of them treats
    // specially would come back as something other than what was measured.
    const value = { constructor: 1, toJSON: "x", hasOwnProperty: [true] };
    await records.put(PLUGIN, "values", "names", value);
    await expect(records.get(PLUGIN, "values", "names")).resolves.toMatchObject(
      { value },
    );

    // The client drops this one, so the record would hold `{}`.
    const proto = JSON.parse('{"__proto__":{"rotation":10}}') as JsonValue;
    await expect(records.put(PLUGIN, "values", "proto", proto)).rejects.toThrow(
      TypeError,
    );
  });

  it("answers null for a record that is not there", async () => {
    await expect(records.get(PLUGIN, "screens", "nowhere")).resolves.toBeNull();
  });

  it("never reads or deletes another plugin's record under the same name", async () => {
    await records.put(OTHER, "screens", "hall", { theirs: true });

    await expect(records.get(PLUGIN, "screens", "hall")).resolves.toBeNull();
    await expect(records.list(PLUGIN, "screens")).resolves.toEqual([]);
    await expect(records.delete(PLUGIN, "screens", "hall")).resolves.toBe(
      false,
    );
    await expect(records.get(OTHER, "screens", "hall")).resolves.toMatchObject({
      value: { theirs: true },
    });
  });

  it("deletes, and says whether there was a record to delete", async () => {
    await records.put(PLUGIN, "screens", "hall", 1);

    await expect(records.delete(PLUGIN, "screens", "hall")).resolves.toBe(true);
    await expect(records.delete(PLUGIN, "screens", "hall")).resolves.toBe(
      false,
    );
    await expect(records.get(PLUGIN, "screens", "hall")).resolves.toBeNull();
  });
});

describe("the compare-and-set on revision", () => {
  it("creates only where there is no record, with expectedRevision null", async () => {
    await records.put(PLUGIN, "screens", "hall", 1, null);

    await expect(
      records.put(PLUGIN, "screens", "hall", 2, null),
    ).rejects.toMatchObject({
      name: "PluginRecordConflictError",
      actualRevision: 1,
    });
  });

  it("writes only over the revision expected", async () => {
    await records.put(PLUGIN, "screens", "hall", 1);
    await records.put(PLUGIN, "screens", "hall", 2);

    await expect(
      records.put(PLUGIN, "screens", "hall", 3, 1),
    ).rejects.toBeInstanceOf(PluginRecordConflictError);
    await expect(
      records.put(PLUGIN, "screens", "hall", 3, 2),
    ).resolves.toMatchObject({
      value: 3,
      revision: 3,
    });
    // Over a record that is not there, a revision is a conflict too.
    await expect(
      records.put(PLUGIN, "screens", "lobby", 1, 1),
    ).rejects.toMatchObject({ actualRevision: null });
  });

  it("deletes only the revision expected", async () => {
    await records.put(PLUGIN, "screens", "hall", 1);
    await records.put(PLUGIN, "screens", "hall", 2);

    await expect(
      records.delete(PLUGIN, "screens", "hall", 1),
    ).rejects.toBeInstanceOf(PluginRecordConflictError);
    await expect(records.delete(PLUGIN, "screens", "hall", 2)).resolves.toBe(
      true,
    );
  });

  /*
   * Each write through a service of its own, as from processes of their own:
   * one service queues a plugin's writes before they reach the database, and
   * these are about the lock that holds between processes.
   */
  function processes(count: number): PluginRecordsService[] {
    return Array.from(
      { length: count },
      () => new PluginRecordsService(prisma),
    );
  }

  it("lets exactly one of two creates arriving together through", async () => {
    const outcomes = await Promise.allSettled(
      processes(6).map((service, index) =>
        service.put(PLUGIN, "claims", "p12", { by: index }, null),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(PluginRecordConflictError);
      }
    }
  });

  it("lets exactly one of two writes over the same revision through", async () => {
    await records.put(PLUGIN, "screens", "hall", 0);
    const outcomes = await Promise.allSettled(
      processes(6).map((service, index) =>
        service.put(PLUGIN, "screens", "hall", index, 1),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(records.get(PLUGIN, "screens", "hall")).resolves.toMatchObject(
      {
        revision: 2,
      },
    );
  });
});

describe("a burst of writes from one plugin", () => {
  /*
   * A write waits for the plugin's lock inside its transaction, which holds a
   * connection from the pool while it waits. Seven writes sent at once, on a
   * client of their own with two connections, while this test holds the lock:
   * written straight to the database they would hold both connections and
   * leave a request of the core's queued behind them for as long as the lock
   * is held.
   */
  it("holds one connection while it waits, and lands every write", async () => {
    const POOL = 2;
    const twoConnections = new PrismaService({
      ...env,
      OPENBRF_DATABASE_POOL_SIZE: POOL,
    });
    await twoConnections.$connect();
    const burst = new PluginRecordsService(twoConnections);

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holder = 0;
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        holder = row?.pid ?? 0;
        await tx.$queryRaw`SELECT 1 FROM installed_plugin WHERE id = ${PLUGIN} FOR NO KEY UPDATE`;
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    let writes: Promise<unknown>[] = [];
    let timer: NodeJS.Timeout | undefined;

    try {
      // The holder's failure, rather than a wait for a lock never taken.
      await Promise.race([isLocked, holding]);
      writes = Array.from({ length: POOL + 5 }, (_, index) =>
        burst.put(PLUGIN, "screens", "hall", { write: index }),
      );
      // Only the sessions this test's lock holds up.
      const waiting = async (): Promise<number> => {
        const [row] = await prisma.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE ${holder}::int = ANY(pg_blocking_pids(pid))`;
        return row?.count ?? 0;
      };
      await vi.waitFor(
        async () => {
          expect(await waiting()).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );

      // A request of the core's, on the same pool, while the lock is held.
      const answered = await Promise.race([
        twoConnections.$queryRaw<{ free: number }[]>`SELECT 1 AS free`,
        new Promise<"timed out">((resolve) => {
          timer = setTimeout(() => {
            resolve("timed out");
          }, 2000);
        }),
      ]);
      expect(answered).toEqual([{ free: 1 }]);
      expect(await waiting()).toBe(1);

      release();
      await holding;
      const outcomes = await Promise.allSettled(writes);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(
        Array.from({ length: POOL + 5 }, () => "fulfilled"),
      );
      await expect(
        records.get(PLUGIN, "screens", "hall"),
      ).resolves.toMatchObject({ revision: POOL + 5 });
    } finally {
      clearTimeout(timer);
      release();
      await holding.catch(() => undefined);
      await Promise.allSettled(writes);
      await twoConnections.$disconnect();
    }
  });

  it("goes on with the writes after one that threw", async () => {
    const outcomes = await Promise.allSettled([
      records.put(PLUGIN, "claims", "hall", 1, null),
      records.put(PLUGIN, "claims", "hall", 2, null),
      records.put(PLUGIN, "claims", "hall", 3),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    await expect(records.get(PLUGIN, "claims", "hall")).resolves.toMatchObject({
      value: 3,
      revision: 2,
    });
  });
});

describe("listing", () => {
  it("pages through a collection in key order", async () => {
    // Out of order, in two cases and with punctuation, which a linguistic
    // collation would sort its own way.
    const keys = ["b", "A", "a-2", "a.1", "a_3", "a:4", "B", "010", "002"];
    for (const key of keys) {
      await records.put(PLUGIN, "screens", key, key);
    }
    await records.put(PLUGIN, "layouts", "a", "not a screen");

    const firstPage = await records.list(PLUGIN, "screens", { limit: 4 });
    const secondPage = await records.list(PLUGIN, "screens", {
      after: firstPage.at(-1)?.key,
      limit: 4,
    });
    const thirdPage = await records.list(PLUGIN, "screens", {
      after: secondPage.at(-1)?.key,
    });

    expect(
      [...firstPage, ...secondPage, ...thirdPage].map((record) => record.key),
    ).toEqual([...keys].sort());
    expect(thirdPage).toHaveLength(1);
  });

  it("returns at most 200 records without a limit", async () => {
    await prisma.pluginRecord.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        pluginId: PLUGIN,
        collection: "many",
        key: String(index).padStart(3, "0"),
        value: index,
        size: 3,
      })),
    });

    await expect(records.list(PLUGIN, "many")).resolves.toHaveLength(
      PLUGIN_RECORD_LIMITS.listLimit,
    );
  });
});

describe("the limits a plugin is held to", () => {
  it("refuses a record past 10 000, and takes an overwrite at the limit", async () => {
    await prisma.pluginRecord.createMany({
      data: Array.from(
        { length: PLUGIN_RECORD_LIMITS.records },
        (_, index) => ({
          pluginId: PLUGIN,
          collection: "full",
          key: String(index),
          value: index,
          size: 4,
        }),
      ),
    });

    await expect(
      records.put(PLUGIN, "full", "one-more", 1),
    ).rejects.toMatchObject({
      name: "PluginRecordLimitError",
      limit: "records",
    });
    await expect(
      records.put(PLUGIN, "full", "0", "over"),
    ).resolves.toMatchObject({
      revision: 2,
    });
    // Another plugin's records are its own count.
    await expect(
      records.put(OTHER, "full", "one-more", 1),
    ).resolves.toBeDefined();
  });

  it("refuses a write past 16 MiB in all, and takes one that shrinks", async () => {
    // The sizes are the host's own account, which is what the limit counts;
    // the values behind them can be small.
    const rows =
      PLUGIN_RECORD_LIMITS.totalBytes / PLUGIN_RECORD_LIMITS.valueBytes;
    await prisma.pluginRecord.createMany({
      data: Array.from({ length: rows }, (_, index) => ({
        pluginId: PLUGIN,
        collection: "big",
        key: String(index),
        value: index,
        size: PLUGIN_RECORD_LIMITS.valueBytes,
      })),
    });

    await expect(records.put(PLUGIN, "big", "more", 1)).rejects.toMatchObject({
      limit: "totalBytes",
    });
    await expect(records.put(PLUGIN, "big", "0", 1)).resolves.toMatchObject({
      revision: 2,
    });
    // Now that one is small, a small one more fits.
    await expect(records.put(PLUGIN, "big", "more", 1)).resolves.toBeDefined();
  });

  it("refuses a value over 64 KiB before it is written", async () => {
    await expect(
      records.put(
        PLUGIN,
        "big",
        "one",
        "x".repeat(PLUGIN_RECORD_LIMITS.valueBytes),
      ),
    ).rejects.toBeInstanceOf(PluginRecordLimitError);
    await expect(records.get(PLUGIN, "big", "one")).resolves.toBeNull();
  });
});

describe("removing the plugin", () => {
  it("deletes its records with its row, and leaves another plugin's", async () => {
    await records.put(PLUGIN, "screens", "hall", 1);
    await records.put(PLUGIN, "layouts", "grid", 2);
    await records.put(OTHER, "screens", "hall", 3);

    await expect(registry.remove(PLUGIN)).resolves.toBe(true);

    await expect(
      prisma.pluginRecord.count({ where: { pluginId: PLUGIN } }),
    ).resolves.toBe(0);
    await expect(
      prisma.pluginRecord.count({ where: { pluginId: OTHER } }),
    ).resolves.toBe(1);
  });

  it("refuses a write once the plugin's row is gone", async () => {
    await registry.remove(PLUGIN);

    await expect(
      records.put(PLUGIN, "screens", "hall", 1),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
    await expect(
      records.delete(PLUGIN, "screens", "hall"),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
  });

  it("refuses another package under its id, and keeps its records for its own", async () => {
    await records.put(PLUGIN, "screens", "hall", { theirs: true });

    await expect(
      install(PLUGIN, {
        packageName: `@elsewhere/${PLUGIN}`,
        version: "2.0.0",
      }),
    ).rejects.toBeInstanceOf(PluginPackageChangedError);
    await expect(registry.find(PLUGIN)).resolves.toMatchObject({
      packageName: `@example/${PLUGIN}`,
      version: "1.0.0",
    });
    await expect(records.get(PLUGIN, "screens", "hall")).resolves.toMatchObject(
      { value: { theirs: true } },
    );

    // A new release of the same package keeps them.
    await install(PLUGIN, { version: "1.1.0" });
    await expect(
      prisma.pluginRecord.count({ where: { pluginId: PLUGIN } }),
    ).resolves.toBe(1);
  });

  it("keeps its records when it is switched off", async () => {
    await records.put(PLUGIN, "screens", "hall", 1);
    await prisma.installedPlugin.update({
      where: { id: PLUGIN },
      data: { enabled: false },
    });

    await expect(
      prisma.pluginRecord.count({ where: { pluginId: PLUGIN } }),
    ).resolves.toBe(1);
  });
});

import {
  PLUGIN_RECORD_COLLECTION_PATTERN,
  PLUGIN_RECORD_KEY_PATTERN,
  PLUGIN_RECORD_LIMITS,
  PluginRecordIdentityNumberError,
  PluginRecordLimitError,
} from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  PluginRecordsService,
  refuseIdentityNumbers,
  snapshotValue,
} from "./plugin-records.service";

/**
 * What `host.records` refuses before it reaches the database (ADR 0033).
 *
 * The store, the compare-and-set and the limits a plugin's records are held to
 * are in `plugin-records.int-spec.ts`; these are the checks on a call's own
 * arguments, which need no database to answer.
 */

/** Skatteverket's own example number, which passes the date and Luhn checks. */
const IDENTITY_NUMBER = "811228-9874";

describe("a record's value", () => {
  it("is measured as JSON in UTF-8", () => {
    expect(snapshotValue("signage", { name: "Hall" }).size).toBe(
      Buffer.byteLength('{"name":"Hall"}'),
    );
    // Two bytes each for å, ä and ö: the limit is on bytes, not characters.
    expect(snapshotValue("signage", "åäö").size).toBe(8);
    expect(snapshotValue("signage", null).size).toBe(4);
  });

  it.each([
    ["undefined", { rotation: undefined }],
    ["a function", { render: () => null }],
    ["NaN", { rotation: Number.NaN }],
    ["Infinity", [Number.POSITIVE_INFINITY]],
    ["a Date", { at: new Date(0) }],
    ["a class instance", { at: new Map() }],
    ["a bigint", { size: 1n }],
    ["a NUL character", { name: "Hall\u0000" }],
    ["a NUL character in a property name", { "na\u0000me": "Hall" }],
    ["a lone surrogate", { name: "\uD83D" }],
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case.
    ["a hole in an array", [1, , 3]],
  ])("refuses %s, which JSON cannot carry exactly", (_what, value) => {
    expect(() => snapshotValue("signage", value)).toThrow(TypeError);
  });

  it("accepts an object with no prototype, and a surrogate pair", () => {
    const bare = Object.assign(Object.create(null) as object, { a: "😀" });
    expect(snapshotValue("signage", bare).size).toBe(
      Buffer.byteLength('{"a":"😀"}'),
    );
  });

  it("refuses a value nested deeper than 64 levels, and a cycle", () => {
    let deep: unknown = 0;
    for (let level = 0; level < 65; level++) {
      deep = [deep];
    }
    expect(() => snapshotValue("signage", deep)).toThrow(TypeError);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => snapshotValue("signage", cycle)).toThrow(TypeError);
  });

  it("refuses a value over 64 KiB, and takes one at the limit", () => {
    // Two quotes around the string.
    const atLimit = "x".repeat(PLUGIN_RECORD_LIMITS.valueBytes - 2);
    expect(snapshotValue("signage", atLimit).size).toBe(
      PLUGIN_RECORD_LIMITS.valueBytes,
    );
    expect(() => snapshotValue("signage", `${atLimit}x`)).toThrow(
      PluginRecordLimitError,
    );
  });

  it("stops walking shared elements past what 64 KiB can hold", () => {
    // 300 references to one array of 300 numbers: small in memory, over 64
    // KiB as JSON, and refused before it is serialised.
    const row = Array.from({ length: 300 }, () => 1);
    const shared = Array.from({ length: 300 }, () => row);
    expect(() => snapshotValue("signage", shared)).toThrow(
      PluginRecordLimitError,
    );
  });

  it.each([
    ["escapes", { 'say "hi"\\': "a\bb\tc\nd\fe\rf\u0001g\u001f" }],
    ["two, three and four bytes", ["ö", "€", "😀", "\u2028"]],
    ["numbers", [0, -0, 1.5, -1e21, 5e-324, Number.MAX_VALUE]],
    ["nesting", { a: [], b: {}, c: [[{}], { d: [true, false, null] }] }],
  ])("is measured as JSON.stringify writes it: %s", (_what, value) => {
    expect(snapshotValue("signage", value).size).toBe(
      Buffer.byteLength(JSON.stringify(value)),
    );
  });

  it("takes an object exactly at the limit, and refuses one byte more", () => {
    // {"a":"…"} is eight bytes around the string.
    const atLimit = { a: "x".repeat(PLUGIN_RECORD_LIMITS.valueBytes - 8) };
    expect(snapshotValue("signage", atLimit).size).toBe(
      PLUGIN_RECORD_LIMITS.valueBytes,
    );
    expect(() => snapshotValue("signage", { a: `${atLimit.a}x` })).toThrow(
      PluginRecordLimitError,
    );
    expect(() => snapshotValue("signage", { a: `${atLimit.a}\n` })).toThrow(
      PluginRecordLimitError,
    );
  });

  it.each([
    // 4 GiB of JSON from one string of 64 KiB.
    ["65,534 references to one long string", 65_534, 65_534],
    // Each string fits; together they do not.
    ["a long string repeated", 1024, 40_000],
  ])(
    "refuses %s before reading past the limit or serialising it",
    (_what, count, length) => {
      let reads = 0;
      const shared = new Proxy(Array(count).fill("x".repeat(length)), {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            reads += 1;
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        expect(() => snapshotValue("signage", shared)).toThrow(
          PluginRecordLimitError,
        );
        expect(stringify).not.toHaveBeenCalled();
      } finally {
        stringify.mockRestore();
      }
      expect(reads).toBeLessThanOrEqual(2);
    },
  );

  it("reads no later getter once an object's first value passes the limit", () => {
    // 256 getters of 64 KiB each: 16 MiB if every one were read.
    const text = "x".repeat(PLUGIN_RECORD_LIMITS.valueBytes);
    let reads = 0;
    const value: Record<string, string> = {};
    for (let index = 0; index < 256; index++) {
      Object.defineProperty(value, `p${String(index)}`, {
        enumerable: true,
        get: () => {
          reads += 1;
          return text;
        },
      });
    }
    expect(() => snapshotValue("signage", value)).toThrow(
      PluginRecordLimitError,
    );
    expect(reads).toBe(1);
  });

  it("reads an object's own enumerable properties only, in the order JSON writes them", () => {
    const value: Record<string, unknown> = { b: 2, 1: 1 };
    Object.defineProperty(value, "hidden", { value: 3, enumerable: false });
    value.a = { c: [true, null] };
    // A polluted Object.prototype adds nothing to the record.
    Object.defineProperty(Object.prototype, "polluted", {
      value: 1,
      enumerable: true,
      configurable: true,
    });
    let snapshot: ReturnType<typeof snapshotValue>;
    try {
      snapshot = snapshotValue("signage", value);
    } finally {
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
    expect(JSON.stringify(snapshot.value)).toBe(JSON.stringify(value));
    expect(snapshot.size).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it("lists an object's names once however often it is referred to, and never its prototype's", () => {
    // 2,000 enumerable names on a prototype JSON never writes, behind an
    // object with none of its own, referred to 1,000 times.
    let prototypeWork = 0;
    const count = {
      ownKeys(target: object) {
        prototypeWork += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target: object, property: string | symbol) {
        prototypeWork += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has(target: object, property: string | symbol) {
        prototypeWork += 1;
        return Reflect.has(target, property);
      },
      get(target: object, property: string | symbol) {
        prototypeWork += 1;
        return Reflect.get(target, property) as unknown;
      },
    };
    const inherited = Object.create(null) as Record<string, number>;
    for (let index = 0; index < 2000; index++) {
      inherited[`p${String(index)}`] = index;
    }
    let listings = 0;
    const row = new Proxy(
      Object.create(new Proxy(inherited, count) as object) as object,
      {
        ownKeys(target) {
          listings += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const value = Array<object>(1000).fill(row);
    const snapshot = snapshotValue("signage", value);
    // Counted before JSON.stringify below lists the row a thousand times.
    expect(listings).toBe(1);
    expect(prototypeWork).toBe(0);
    expect(JSON.stringify(snapshot.value)).toBe(JSON.stringify(value));
    expect(snapshot.size).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it("refuses objects hiding more names than the limit has bytes, before checking past it", () => {
    // 100 objects that each list the same 2,000 names, none of them written.
    const hidden = {};
    for (let index = 0; index < 2000; index++) {
      Object.defineProperty(hidden, `p${String(index)}`, { value: index });
    }
    let checks = 0;
    const value = Array.from(
      { length: 100 },
      () =>
        new Proxy(hidden, {
          getOwnPropertyDescriptor(target, property) {
            checks += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        }),
    );
    expect(() => snapshotValue("signage", value)).toThrow(
      PluginRecordLimitError,
    );
    expect(checks).toBeLessThanOrEqual(PLUGIN_RECORD_LIMITS.valueBytes);
  });

  it("refuses a property name longer than what is left", () => {
    const value = { ["x".repeat(PLUGIN_RECORD_LIMITS.valueBytes)]: 1 };
    expect(() => snapshotValue("signage", value)).toThrow(
      PluginRecordLimitError,
    );
  });

  it("is copied, so changing the plugin's object afterwards changes nothing", () => {
    const screen = { name: "Hall" };
    const value = { screens: [screen] };
    const snapshot = snapshotValue("signage", value);
    screen.name = IDENTITY_NUMBER;
    value.screens.push({ name: "Gård" });
    expect(snapshot.value).toEqual({ screens: [{ name: "Hall" }] });
  });

  it("reads a getter once, and serialises what it answered", () => {
    let reads = 0;
    const value = {
      get name() {
        reads += 1;
        return reads === 1 ? "Hall" : IDENTITY_NUMBER;
      },
    };
    const snapshot = snapshotValue("signage", value);
    expect(JSON.stringify(snapshot.value)).toBe('{"name":"Hall"}');
    expect(reads).toBe(1);
  });

  it("refuses a property named __proto__, which the store would drop", () => {
    // JSON.parse makes it an own property, as a plugin reading JSON would.
    const value = JSON.parse('{"screen":{"__proto__":{"a":1}}}') as object;
    expect(() => snapshotValue("signage", value)).toThrow(TypeError);
  });
});

describe("a write", () => {
  /**
   * A transaction double for a plugin with no records yet, which keeps what
   * the write hands the database. The lock and the reads each wait a turn, as
   * the database's do, so the plugin has its chance to change what it passed.
   */
  function storeDouble() {
    const created: { value: unknown; size: number }[] = [];
    const tx = {
      $queryRaw: async () => [1],
      pluginRecord: {
        findFirst: async () => null,
        aggregate: async () => ({ _count: { _all: 0 }, _sum: { size: 0 } }),
        create: async ({
          data,
        }: {
          data: {
            collection: string;
            key: string;
            value: unknown;
            size: number;
          };
        }) => {
          created.push({ value: data.value, size: data.size });
          return { ...data, revision: 1, updatedAt: new Date(0) };
        },
      },
    };
    const prisma = {
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) =>
        await run(tx),
    };
    return { service: new PluginRecordsService(prisma as never), created };
  }

  const HALL = { value: { label: "Hall" }, size: 16 };

  it("stores the value it checked, not one the plugin changed after the call", async () => {
    const { service, created } = storeDouble();
    const value: Record<string, string> = { label: "Hall" };
    const written = service.put("signage", "screens", "hall", value);
    value.label = "x".repeat(PLUGIN_RECORD_LIMITS.valueBytes + 1);
    value.note = IDENTITY_NUMBER;
    await written;

    expect(created).toEqual([HALL]);
  });

  it("stores what a getter answered when it was checked, not on a later read", async () => {
    const { service, created } = storeDouble();
    let reads = 0;
    const value = {
      get label() {
        reads += 1;
        return reads === 1 ? "Hall" : IDENTITY_NUMBER;
      },
    };
    await service.put("signage", "screens", "hall", value);

    expect(reads).toBe(1);
    expect(created).toEqual([HALL]);
  });

  it("stores what a Proxy answered when it was checked", async () => {
    const { service, created } = storeDouble();
    let reads = 0;
    const value = new Proxy(
      { label: "Hall" },
      {
        get: (target, property, receiver) => {
          reads += 1;
          return reads === 1
            ? (Reflect.get(target, property, receiver) as unknown)
            : IDENTITY_NUMBER;
        },
      },
    );
    await service.put("signage", "screens", "hall", value);

    expect(created).toEqual([HALL]);
  });
});

describe("writes waiting their turn", () => {
  /** A database whose transactions all wait until `open` is called. */
  function gatedStore() {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let started = 0;
    const tx = {
      $queryRaw: async () => [1],
      pluginRecord: {
        findFirst: async () => null,
        aggregate: async () => ({ _count: { _all: 0 }, _sum: { size: 0 } }),
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          revision: 1,
          updatedAt: new Date(0),
        }),
      },
    };
    const prisma = {
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => {
        started += 1;
        await gate;
        return await run(tx);
      },
    };
    return {
      service: new PluginRecordsService(prisma as never),
      open,
      started: () => started,
    };
  }

  it("are held to a number per plugin, and refused past it with a named error", async () => {
    const { service, open, started } = gatedStore();
    const cap = PLUGIN_RECORD_LIMITS.queuedWrites;
    const queued = Array.from({ length: cap }, (_, index) =>
      service.put("signage", "screens", `k${String(index)}`, index),
    );
    const refused = await service
      .put("signage", "screens", "over", 0)
      .catch((error: unknown) => error);
    const delete_ = await service
      .delete("signage", "screens", "over")
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PluginRecordLimitError);
    expect(refused).toMatchObject({
      name: "PluginRecordLimitError",
      limit: "queuedWrites",
    });
    expect(delete_).toBeInstanceOf(PluginRecordLimitError);
    // The line still holds one connection however long it is.
    await vi.waitFor(() => {
      expect(started()).toBe(1);
    });

    // Another plugin's line is its own.
    const other = service.put("billboards", "screens", "hall", 0);

    open();
    await expect(Promise.all(queued)).resolves.toHaveLength(cap);
    await expect(other).resolves.toMatchObject({ key: "hall" });
    // Drained, the plugin writes again.
    await expect(
      service.put("signage", "screens", "over", 0),
    ).resolves.toMatchObject({ key: "over" });
  });

  it("do not count a write refused before it queued", async () => {
    const { service, open } = gatedStore();
    await expect(
      service.put("signage", "screens", "bad key!", 0),
    ).rejects.toThrow(RangeError);
    const cap = PLUGIN_RECORD_LIMITS.queuedWrites;
    const queued = Array.from({ length: cap }, (_, index) =>
      service.put("signage", "screens", `k${String(index)}`, index),
    );
    open();
    await expect(Promise.all(queued)).resolves.toHaveLength(cap);
  });
});

describe("a personal identity number in a record", () => {
  it.each([
    ["a string", "screens", "hall", { note: `Ring ${IDENTITY_NUMBER}` }],
    ["a property name", "screens", "hall", { [IDENTITY_NUMBER]: true }],
    ["a nested string", "screens", "hall", { list: [{ a: IDENTITY_NUMBER }] }],
    ["a number", "screens", "hall", { id: 198112289874 }],
    ["the key", "screens", IDENTITY_NUMBER, { rotation: 10 }],
    ["the collection", "8112289874", "hall", { rotation: 10 }],
  ])("is refused in %s", (_where, collection, key, value) => {
    expect(() =>
      refuseIdentityNumbers("signage", collection, key, value),
    ).toThrow(PluginRecordIdentityNumberError);
  });

  it("is not in the error's message", () => {
    expect(() =>
      refuseIdentityNumbers("signage", "screens", "hall", IDENTITY_NUMBER),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("9874") as unknown,
      }),
    );
  });

  it("lets a date, an amount and an organisation number through", () => {
    expect(() =>
      refuseIdentityNumbers("signage", "screens", "2026-10-20", {
        from: "2026-10-20",
        amount: 4_250_000,
        organisation: "769600-1234",
        rotation: 10,
      }),
    ).not.toThrow();
  });
});

describe("a call's names and options", () => {
  // Every argument is checked before the database is asked anything, so a
  // service with no client behind it is enough.
  const service = new PluginRecordsService({} as never);

  it.each([
    "",
    "Screens",
    "-screens",
    "screens-",
    "two--hyphens",
    "a_b",
    "x".repeat(33),
  ])("refuses the collection %j", async (collection) => {
    expect(PLUGIN_RECORD_COLLECTION_PATTERN.test(collection)).toBe(false);
    await expect(service.get("signage", collection, "hall")).rejects.toThrow(
      RangeError,
    );
  });

  it("accepts a collection of 32 characters with single hyphens", () => {
    expect(PLUGIN_RECORD_COLLECTION_PATTERN.test("entrance-2-screens")).toBe(
      true,
    );
    expect(PLUGIN_RECORD_COLLECTION_PATTERN.test("x".repeat(32))).toBe(true);
  });

  it.each(["", "a b", "a/b", "å", "x".repeat(129)])(
    "refuses the key %j",
    async (key) => {
      expect(PLUGIN_RECORD_KEY_PATTERN.test(key)).toBe(false);
      await expect(service.get("signage", "screens", key)).rejects.toThrow(
        RangeError,
      );
    },
  );

  it.each([0, 201, 1.5, Number.NaN])(
    "refuses a list limit of %d",
    async (limit) => {
      await expect(
        service.list("signage", "screens", { limit }),
      ).rejects.toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, "1"])(
    "refuses an expected revision of %j",
    async (expectedRevision) => {
      await expect(
        service.put("signage", "screens", "hall", 1, expectedRevision as never),
      ).rejects.toThrow(RangeError);
      await expect(
        service.delete("signage", "screens", "hall", expectedRevision as never),
      ).rejects.toThrow(RangeError);
    },
  );

  it("refuses null as a delete's expected revision", async () => {
    // Create-only is a put's; a delete of a record that is not there is
    // already `false`.
    await expect(
      service.delete("signage", "screens", "hall", null as never),
    ).rejects.toThrow(RangeError);
  });
});

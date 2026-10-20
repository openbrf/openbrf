import {
  PLUGIN_RECORD_COLLECTION_PATTERN,
  PLUGIN_RECORD_KEY_PATTERN,
  PLUGIN_RECORD_LIMITS,
  PluginRecordIdentityNumberError,
  PluginRecordLimitError,
} from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  PluginRecordsService,
  refuseIdentityNumbers,
  serialisedSize,
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
    expect(serialisedSize("signage", { name: "Hall" })).toBe(
      Buffer.byteLength('{"name":"Hall"}'),
    );
    // Two bytes each for å, ä and ö: the limit is on bytes, not characters.
    expect(serialisedSize("signage", "åäö")).toBe(8);
    expect(serialisedSize("signage", null)).toBe(4);
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
    expect(() => serialisedSize("signage", value)).toThrow(TypeError);
  });

  it("accepts an object with no prototype, and a surrogate pair", () => {
    const bare = Object.assign(Object.create(null) as object, { a: "😀" });
    expect(serialisedSize("signage", bare)).toBe(
      Buffer.byteLength('{"a":"😀"}'),
    );
  });

  it("refuses a value nested deeper than 64 levels, and a cycle", () => {
    let deep: unknown = 0;
    for (let level = 0; level < 65; level++) {
      deep = [deep];
    }
    expect(() => serialisedSize("signage", deep)).toThrow(TypeError);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => serialisedSize("signage", cycle)).toThrow(TypeError);
  });

  it("refuses a value over 64 KiB, and takes one at the limit", () => {
    // Two quotes around the string.
    const atLimit = "x".repeat(PLUGIN_RECORD_LIMITS.valueBytes - 2);
    expect(serialisedSize("signage", atLimit)).toBe(
      PLUGIN_RECORD_LIMITS.valueBytes,
    );
    expect(() => serialisedSize("signage", `${atLimit}x`)).toThrow(
      PluginRecordLimitError,
    );
  });

  it("stops walking shared elements past what 64 KiB can hold", () => {
    // 300 references to one array of 300 numbers: small in memory, over 64
    // KiB as JSON, and refused before it is serialised.
    const row = Array.from({ length: 300 }, () => 1);
    const shared = Array.from({ length: 300 }, () => row);
    expect(() => serialisedSize("signage", shared)).toThrow(
      PluginRecordLimitError,
    );
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

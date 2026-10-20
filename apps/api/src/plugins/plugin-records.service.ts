import { Injectable } from "@nestjs/common";
import {
  type JsonValue,
  PLUGIN_RECORD_COLLECTION_PATTERN,
  PLUGIN_RECORD_KEY_PATTERN,
  PLUGIN_RECORD_LIMITS,
  type PluginRecord,
  PluginHostUnavailableError,
  PluginRecordConflictError,
  PluginRecordIdentityNumberError,
  PluginRecordLimitError,
} from "@openbrf/plugin-sdk";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";

/**
 * A plugin's own records (ADR 0033), behind `host.records`.
 *
 * Every method takes the plugin's id from the host object, never from the
 * plugin, so a plugin reads and writes its own rows and nobody else's. Not
 * exported from PluginsModule, which is not global either: a plugin's module
 * cannot inject this and name another plugin's id.
 *
 * Writes for one plugin run one after another, under a lock on its installed
 * row. That is what makes a compare-and-set on `revision` and the limits on
 * what a plugin holds exact, rather than true of each write on its own and
 * false of two at once, and it is also where a write meets a removal: one that
 * finds the row gone refuses, as every host service does for a plugin that
 * stopped serving.
 */
@Injectable()
export class PluginRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    pluginId: string,
    collection: string,
    key: string,
  ): Promise<PluginRecord | null> {
    checkCollection(pluginId, collection);
    checkKey(pluginId, key);
    const row = await this.prisma.pluginRecord.findUnique({
      where: { pluginId_collection_key: { pluginId, collection, key } },
    });
    return row === null ? null : toRecord(row);
  }

  async list(
    pluginId: string,
    collection: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<PluginRecord[]> {
    checkCollection(pluginId, collection);
    const { after, limit = PLUGIN_RECORD_LIMITS.listLimit } = options;
    if (after !== undefined) {
      checkKey(pluginId, after);
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > PLUGIN_RECORD_LIMITS.listLimit
    ) {
      throw new RangeError(
        `Plugin "${pluginId}" listed its records with a limit outside 1-` +
          `${String(PLUGIN_RECORD_LIMITS.listLimit)}.`,
      );
    }
    const rows = await this.prisma.pluginRecord.findMany({
      where: {
        pluginId,
        collection,
        ...(after === undefined ? {} : { key: { gt: after } }),
      },
      orderBy: { key: "asc" },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async put(
    pluginId: string,
    collection: string,
    key: string,
    value: JsonValue,
    expectedRevision?: number | null,
  ): Promise<PluginRecord> {
    checkCollection(pluginId, collection);
    checkKey(pluginId, key);
    checkExpectedRevision(pluginId, expectedRevision, true);
    // From here on only the copy is read: the plugin still holds `value` and
    // may change it while the write waits for its lock.
    const { value: copy, size } = snapshotValue(pluginId, value);
    refuseIdentityNumbers(pluginId, collection, key, copy);

    return await this.prisma.$transaction(async (tx) => {
      await lockPlugin(tx, pluginId);
      const where = { pluginId_collection_key: { pluginId, collection, key } };
      const existing = await tx.pluginRecord.findUnique({
        where,
        select: { revision: true, size: true },
      });
      checkRevision(pluginId, existing, expectedRevision);
      await checkTotals(tx, pluginId, existing, size);

      const data = {
        value:
          copy === null ? Prisma.JsonNull : (copy as Prisma.InputJsonValue),
        size,
      };
      const row =
        existing === null
          ? await tx.pluginRecord.create({
              data: { pluginId, collection, key, ...data },
            })
          : await tx.pluginRecord.update({
              where,
              data: { ...data, revision: { increment: 1 } },
            });
      return toRecord(row);
    });
  }

  async delete(
    pluginId: string,
    collection: string,
    key: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    checkCollection(pluginId, collection);
    checkKey(pluginId, key);
    checkExpectedRevision(pluginId, expectedRevision, false);

    return await this.prisma.$transaction(async (tx) => {
      await lockPlugin(tx, pluginId);
      const where = { pluginId_collection_key: { pluginId, collection, key } };
      const existing = await tx.pluginRecord.findUnique({
        where,
        select: { revision: true },
      });
      if (existing === null) {
        return false;
      }
      if (
        expectedRevision !== undefined &&
        existing.revision !== expectedRevision
      ) {
        throw new PluginRecordConflictError(pluginId, existing.revision);
      }
      await tx.pluginRecord.delete({ where });
      return true;
    });
  }
}

/** How deep a value may nest. Deeper than any configuration needs. */
const MAX_VALUE_DEPTH = 64;

/**
 * The lock every write for one plugin takes, on the plugin's installed row.
 *
 * `FOR NO KEY UPDATE` rather than `FOR UPDATE`: two writes of the same
 * plugin's records wait for each other, a removal waits for the write, and the
 * foreign key of the row being written is not blocked by its own lock. A
 * settings save waits for a write too, which is a few milliseconds.
 */
async function lockPlugin(
  tx: Prisma.TransactionClient,
  pluginId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    unknown[]
  >`SELECT 1 FROM installed_plugin WHERE id = ${pluginId} FOR NO KEY UPDATE`;
  if (rows.length === 0) {
    throw new PluginHostUnavailableError(
      pluginId,
      "after it was removed. A removed plugin's records are deleted with it.",
    );
  }
}

function checkRevision(
  pluginId: string,
  existing: { revision: number } | null,
  expectedRevision: number | null | undefined,
): void {
  if (expectedRevision === undefined) {
    return;
  }
  const actual = existing?.revision ?? null;
  if (actual !== expectedRevision) {
    throw new PluginRecordConflictError(pluginId, actual);
  }
}

/**
 * Refuses a write that would take the plugin past its record count or its
 * bytes in all.
 *
 * Only a write that grows the figure is refused, so one that shrinks a value
 * or overwrites it at its own size always goes through. The figures are read
 * under the plugin's lock, so they are the ones the write lands on.
 */
async function checkTotals(
  tx: Prisma.TransactionClient,
  pluginId: string,
  existing: { size: number } | null,
  size: number,
): Promise<void> {
  if (existing !== null && size <= existing.size) {
    return;
  }
  const totals = await tx.pluginRecord.aggregate({
    where: { pluginId },
    _count: { _all: true },
    _sum: { size: true },
  });
  if (existing === null && totals._count._all >= PLUGIN_RECORD_LIMITS.records) {
    throw new PluginRecordLimitError(pluginId, "records");
  }
  const total = (totals._sum.size ?? 0) - (existing?.size ?? 0) + size;
  if (total > PLUGIN_RECORD_LIMITS.totalBytes) {
    throw new PluginRecordLimitError(pluginId, "totalBytes");
  }
}

function checkCollection(pluginId: string, collection: unknown): void {
  if (
    typeof collection !== "string" ||
    !PLUGIN_RECORD_COLLECTION_PATTERN.test(collection)
  ) {
    // The name is left out, as for a job queue's: a plugin may pass anything
    // here, and the error ends up in the log.
    throw new RangeError(
      `Plugin "${pluginId}" named a record collection outside the pattern; ` +
        "a collection is lowercase letters, digits and single hyphens, at " +
        "most 32 characters.",
    );
  }
}

function checkKey(pluginId: string, key: unknown): void {
  if (typeof key !== "string" || !PLUGIN_RECORD_KEY_PATTERN.test(key)) {
    throw new RangeError(
      `Plugin "${pluginId}" named a record key outside the pattern; a key is ` +
        "1-128 letters, digits, '.', '_', ':' or '-'.",
    );
  }
}

function checkExpectedRevision(
  pluginId: string,
  expected: unknown,
  nullable: boolean,
): void {
  if (
    expected === undefined ||
    (nullable && expected === null) ||
    (typeof expected === "number" &&
      Number.isInteger(expected) &&
      expected >= 1)
  ) {
    return;
  }
  throw new RangeError(
    `Plugin "${pluginId}" expected a record revision that is not a positive ` +
      `integer${nullable ? " or null" : ""}.`,
  );
}

/**
 * A copy of the value the plugin cannot reach, once it is known to be JSON
 * exactly, and the copy's size as JSON in UTF-8.
 *
 * A copy, because the plugin keeps the value it passed and the write waits for
 * a lock before it lands: what was measured and scanned has to be what is
 * stored, not whatever the plugin's object holds by then. The copy is made in
 * one synchronous walk that reads each element and property once, so a getter
 * or a Proxy that answers differently on a later read has nothing left to
 * answer, and it holds nothing but arrays, plain objects and primitives the
 * walk built, so serialising it runs no `toJSON` and no getter of the
 * plugin's.
 *
 * Exactly, because the store keeps what JSON carries and the plugin reads that
 * back: `undefined` would vanish from an object, `NaN` would come back as
 * null, a Date as a string and a class instance as a plain object, and the
 * plugin would find out on its next read rather than now. PostgreSQL refuses a
 * NUL character and a lone surrogate in jsonb, so both are refused here, where
 * the refusal can say what it is rather than fail the write as the database's,
 * and the database client drops a property named `__proto__`, so that is
 * refused too.
 *
 * The walk adds up the bytes of JSON it would write as it goes, delimiters,
 * escapes and property names with the rest, and stops as soon as they pass 64
 * KiB. A string is held to what is left before it is scanned, so a value whose
 * arrays share one long string or one long row cannot make the walk do more
 * work than a value of the limit's own size, and no serialisation follows.
 */
export function snapshotValue(
  pluginId: string,
  value: unknown,
): { value: JsonValue; size: number } {
  let size = 0;
  const spend = (bytes: number): void => {
    size += bytes;
    if (size > PLUGIN_RECORD_LIMITS.valueBytes) {
      throw new PluginRecordLimitError(pluginId, "valueBytes");
    }
  };
  const refuse = (what: string): never => {
    throw new TypeError(
      `Plugin "${pluginId}" wrote a record value JSON cannot carry exactly: ${what}.`,
    );
  };
  const spendString = (text: string): void => {
    // At least a byte a code unit, and two quotes: a string longer than what
    // is left is refused before any of it is read.
    spend(text.length + 2);
    checkString(text, refuse);
    spend(jsonStringBytes(text) - text.length - 2);
  };
  const walk = (node: unknown, depth: number): JsonValue => {
    if (depth > MAX_VALUE_DEPTH) {
      refuse(`nested more than ${String(MAX_VALUE_DEPTH)} levels deep`);
    }
    switch (typeof node) {
      case "boolean":
        spend(node ? 4 : 5);
        return node;
      case "number":
        if (!Number.isFinite(node)) {
          refuse("a number that is not finite");
        }
        // A finite number is written as String writes it, -0 as 0.
        spend(String(node).length);
        return node;
      case "string":
        spendString(node);
        return node;
      case "object":
        break;
      default:
        refuse(`a value of type ${typeof node}`);
    }
    if (node === null) {
      spend(4);
      return null;
    }
    // The brackets or the braces; each loop below adds its commas.
    spend(2);
    if (Array.isArray(node)) {
      const length = (node as unknown[]).length;
      const copy: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        if (index > 0) {
          spend(1);
        }
        copy.push(walk((node as unknown[])[index], depth + 1));
      }
      return copy;
    }
    // A plain object of any realm: its prototype is null or some realm's
    // Object.prototype, whose own prototype is null.
    const prototype: unknown = Object.getPrototypeOf(node);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      refuse("an object that is not a plain object");
    }
    const copy: { [key: string]: JsonValue } = {};
    let first = true;
    for (const [property, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      // The comma before it, and the colon after its name.
      spend(first ? 1 : 2);
      first = false;
      spendString(property);
      // JSON.parse makes `__proto__` an ordinary property, but the database
      // client drops it on the way in, so the record would hold less than was
      // measured. Refused here, which also lets the copy be assigned to.
      if (property === "__proto__") {
        refuse("a property named __proto__, which the store does not keep");
      }
      copy[property] = walk(child, depth + 1);
    }
    return copy;
  };
  const copy = walk(value, 0);
  return { value: copy, size };
}

/** Backspace, tab, line feed, form feed and carriage return: `\b` and the rest. */
const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/**
 * The bytes `JSON.stringify` writes for a string, in UTF-8, quotes included.
 *
 * A quote and a backslash are escaped with a backslash, as are backspace, tab,
 * line feed, form feed and carriage return; any other control character is
 * written `\u00XX`. A surrogate pair is four bytes, two for each half: a lone
 * surrogate, which would be escaped, is refused before this is asked.
 */
function jsonStringBytes(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) {
      bytes += 2;
    } else if (unit < 0x20) {
      bytes += SHORT_ESCAPES.has(unit) ? 2 : 6;
    } else if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff)) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** A high surrogate with no low one after it, or a low one with none before. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkString(text: string, refuse: (what: string) => never): void {
  if (text.includes("\u0000")) {
    refuse("a NUL character");
  }
  if (LONE_SURROGATE.test(text)) {
    refuse("a lone surrogate");
  }
}

/**
 * Refuses a record carrying a personal identity number, as a page is refused
 * one (ADR 0033).
 *
 * Every string in the value is scanned on its own - each value and each
 * property name - and so is every number, written as JSON writes it: a number
 * is as easily a personnummer as a string is. The collection and the key are
 * scanned as well, since a key is the first thing a plugin reaches for to name
 * a row by. The scan is the publication guardrail's, so a date, an amount or
 * an organisation number goes through.
 */
export function refuseIdentityNumbers(
  pluginId: string,
  collection: string,
  key: string,
  value: JsonValue,
): void {
  const texts: string[] = [collection, key];
  const collect = (node: JsonValue): void => {
    if (typeof node === "string") {
      texts.push(node);
    } else if (typeof node === "number") {
      texts.push(JSON.stringify(node));
    } else if (Array.isArray(node)) {
      for (const child of node as readonly JsonValue[]) {
        collect(child);
      }
    } else if (node !== null && typeof node === "object") {
      for (const [property, child] of Object.entries(
        node as { readonly [key: string]: JsonValue },
      )) {
        texts.push(property);
        collect(child);
      }
    }
  };
  collect(value);
  if (texts.some((text) => scanForPersonalIdentityNumbers(text).length > 0)) {
    throw new PluginRecordIdentityNumberError(pluginId);
  }
}

function toRecord(row: {
  collection: string;
  key: string;
  value: Prisma.JsonValue;
  revision: number;
  updatedAt: Date;
}): PluginRecord {
  return {
    collection: row.collection,
    key: row.key,
    value: row.value as JsonValue,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

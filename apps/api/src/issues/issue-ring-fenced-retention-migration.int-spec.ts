import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { scratchDatabases, withClient } from "../testing/scratch-databases";

/**
 * The migration that gives the board the ring-fenced clock (decision 32, ADR
 * 0057), run against an association the version before it stored.
 *
 * A scratch database is brought up to every migration before this one, and
 * each case writes an association in that shape, runs this migration's SQL and
 * reads back what it made of it, in a transaction that is rolled back so the
 * next case starts from the old shape again.
 *
 * What it holds the migration to: an existing instance starts at one year, the
 * clock the purge kept before the setting, so an upgrade moves no pending date;
 * the board's clock for the ordinary types is left as the board set it; and a
 * clock outside one to ten is refused.
 */

const MIGRATION_NAME = "20261109090000_issue_ring_fenced_text_retention";

const migrations = join(process.cwd(), "prisma", "migrations");

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(migrations, MIGRATION_NAME, "migration.sql"),
  "utf8",
);

const scratch = scratchDatabases();
let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await scratch.create("issue_ring_fenced_clock");
  await withClient(databaseUrl, async (client) => {
    const before = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < MIGRATION_NAME)
      .map((entry) => entry.name)
      .sort();
    for (const name of before) {
      await client.query(
        readFileSync(join(migrations, name, "migration.sql"), "utf8"),
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await scratch.dropAll();
});

/** Thrown to roll a case's transaction back once it has read its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back");
  }
}

/**
 * Writes an association whose board kept free text the years given, runs the
 * migration, and hands the client to `read` inside one transaction, then rolls
 * everything back.
 */
async function migrated<T>(
  boardYears: number,
  read: (client: Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO "association" ("id", "name", "issueTextRetentionYears", "updatedAt")
         VALUES (1, 'Brf Talgoxen', $1, now())`,
        [boardYears],
      );
      await client.query(MIGRATION);
      throw new RolledBack(await read(client));
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof RolledBack) {
        return error.answer as T;
      }
      throw error;
    }
  });
}

/** Whether the database refuses the ring-fenced clock set to `years`. */
async function refuses(client: Client, years: number): Promise<boolean> {
  await client.query("SAVEPOINT bounds");
  const refused = await client
    .query(
      `UPDATE "association" SET "ringFencedIssueTextRetentionYears" = $1`,
      [years],
    )
    .then(
      () => false,
      () => true,
    );
  await client.query("ROLLBACK TO SAVEPOINT bounds");
  return refused;
}

describe("the ring-fenced clock migration", () => {
  it("starts an existing instance at one year and leaves the board's other clock as it was", async () => {
    const answer = await migrated(7, async (client) => {
      const { rows } = await client.query<{
        years: number;
        ringFencedYears: number;
      }>(
        `SELECT "issueTextRetentionYears" AS "years",
                "ringFencedIssueTextRetentionYears" AS "ringFencedYears"
         FROM "association"`,
      );
      return rows[0];
    });
    expect(answer).toEqual({ years: 7, ringFencedYears: 1 });
  });

  it("takes a clock from one to ten years and refuses one outside it", async () => {
    const answer = await migrated(2, async (client) => ({
      zero: await refuses(client, 0),
      one: await refuses(client, 1),
      ten: await refuses(client, 10),
      eleven: await refuses(client, 11),
    }));
    expect(answer).toEqual({
      zero: true,
      one: false,
      ten: false,
      eleven: true,
    });
  });
});

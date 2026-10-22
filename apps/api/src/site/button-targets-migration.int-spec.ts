import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { scratchDatabases, withClient } from "../testing/scratch-databases";
import { linkedPageIds, readPageContent } from "./page-content";

/**
 * The migration that makes a button name a built-in page by the page's id,
 * run against the bodies an older version stored.
 *
 * The promise is that every button leads where it led, to everybody it was
 * shown to. So a scratch database is brought up to the migration before this
 * one, built-in pages and all, as an instance meets it on the day it upgrades;
 * each case writes pages whose buttons name a built-in page by its old key,
 * runs this migration's SQL, and reads back what it made of them. Every case
 * runs in a transaction that is rolled back, so the next one starts from the
 * old shape again.
 */

const MIGRATION_NAME = "20261020100300_button_targets_name_built_in_pages";

const migrations = join(process.cwd(), "prisma", "migrations");

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(migrations, MIGRATION_NAME, "migration.sql"),
  "utf8",
);

const scratch = scratchDatabases();
let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await scratch.create("button_targets");
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

/** A page row as this migration finds and leaves it. */
interface PageRow {
  content: unknown;
  revision: number;
  updatedAt: Date;
}

/**
 * Writes pages with these bodies, runs the migration and reads every one of
 * them back, in the order given, inside one transaction that is then rolled
 * back.
 */
async function migrated(bodies: readonly unknown[]): Promise<{
  before: PageRow[];
  after: PageRow[];
  paths: Map<string, string>;
}> {
  return withClient(databaseUrl, async (client) => {
    await client.query("BEGIN");
    try {
      const ids = bodies.map((_, index) => `page-${String(index)}`);
      for (const [index, body] of bodies.entries()) {
        await client.query(
          `INSERT INTO "page" ("id", "slug", "title", "content", "status",
             "slugFollowsTitle", "revision", "updatedAt")
           VALUES ($1, $1, $1, $2, 'PUBLIC', false, 3,
             TIMESTAMP '2026-10-18 09:00:00')`,
          [ids[index], JSON.stringify(body)],
        );
      }
      const before = await rowsOf(client, ids);
      await client.query(MIGRATION);
      throw new RolledBack({
        before,
        after: await rowsOf(client, ids),
        paths: await pathsOf(client),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof RolledBack) {
        return error.answer as {
          before: PageRow[];
          after: PageRow[];
          paths: Map<string, string>;
        };
      }
      throw error;
    }
  });
}

async function rowsOf(
  client: Client,
  ids: readonly string[],
): Promise<PageRow[]> {
  const { rows } = await client.query<PageRow & { id: string }>(
    `SELECT "id", "content", "revision", "updatedAt" FROM "page"
     WHERE "id" = ANY($1)`,
    [ids],
  );
  return ids.map((id) => {
    const row = rows.find((one) => one.id === id);
    if (row === undefined) {
      throw new Error(`page ${id} is gone`);
    }
    return {
      content: row.content,
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  });
}

/** Every page's address, by its id, as the renderer leads a button to it. */
async function pathsOf(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; slug: string }>(
    `SELECT "id", "slug" FROM "page"`,
  );
  return new Map(rows.map((row) => [row.id, `/${row.slug}`]));
}

/** Where each of a body's buttons leads once it is read, in reading order. */
function addressesOf(content: unknown, paths: Map<string, string>): string[] {
  return linkedPageIds(readPageContent(content)).map(
    (id) => paths.get(id) ?? `no page ${id}`,
  );
}

function button(target: unknown, label = "Gå"): unknown {
  return { type: "button", label, target, style: "primary" };
}

function builtIn(page: string): unknown {
  return { kind: "builtIn", page };
}

describe("a button that named a built-in page by its key", () => {
  it("names the page by its id, and leads to the address the key led to", async () => {
    const body = {
      version: 1,
      blocks: [
        button(builtIn("news"), "Nyheter"),
        {
          type: "banner",
          mediaFileId: "file-1",
          alt: "Gården i maj",
          heading: "Välkommen",
          button: { label: "Kalendern", target: builtIn("calendar") },
        },
        {
          type: "columns",
          columns: [
            { blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }] },
            { blocks: [button(builtIn("broker"), "Mäklarinfo")] },
          ],
        },
      ],
    };

    const { after, paths } = await migrated([body]);

    expect(after[0]?.content).toEqual({
      version: 1,
      blocks: [
        button({ kind: "page", pageId: "built-in-news" }, "Nyheter"),
        {
          type: "banner",
          mediaFileId: "file-1",
          alt: "Gården i maj",
          heading: "Välkommen",
          button: {
            label: "Kalendern",
            target: { kind: "page", pageId: "built-in-calendar" },
          },
        },
        {
          type: "columns",
          columns: [
            { blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }] },
            {
              blocks: [
                button(
                  { kind: "page", pageId: "built-in-broker-information" },
                  "Mäklarinfo",
                ),
              ],
            },
          ],
        },
      ],
    });
    // What the version before rendered for each key.
    expect(addressesOf(after[0]?.content, paths)).toEqual([
      "/nyheter",
      "/kalender",
      "/maklarinfo",
    ]);
  });

  it("is a button this version reads, where before the migration it was dropped", async () => {
    const body = { version: 1, blocks: [button(builtIn("calendar"))] };

    const { before, after } = await migrated([body]);

    expect(readPageContent(before[0]?.content).blocks).toEqual([]);
    expect(readPageContent(after[0]?.content).blocks).toEqual([
      button({ kind: "page", pageId: "built-in-calendar" }),
    ]);
  });

  it("keeps the page's revision and the time it was last saved", async () => {
    const { before, after } = await migrated([
      { version: 1, blocks: [button(builtIn("news"))] },
    ]);

    expect(after[0]?.revision).toBe(before[0]?.revision);
    expect(after[0]?.updatedAt).toEqual(before[0]?.updatedAt);
  });
});

describe("what it leaves alone", () => {
  it("leaves a body with no such button exactly as it was", async () => {
    const bodies = [
      {
        version: 1,
        blocks: [
          button({ kind: "page", pageId: "page-9" }),
          button({ kind: "url", url: "https://exempel.se" }),
          // The word written by the board, not a destination.
          {
            type: "paragraph",
            runs: [{ text: 'A "builtIn" page is one the platform writes.' }],
          },
          { type: "columns", columns: [] },
        ],
      },
      { version: 1, blocks: [] },
    ];

    const { before, after } = await migrated(bodies);

    expect(after.map((row) => row.content)).toEqual(
      before.map((row) => row.content),
    );
  });

  it("leaves a key no version offered, which the reader drops as it always did", async () => {
    const body = {
      version: 1,
      blocks: [button(builtIn("requestAccount")), button(builtIn("news"))],
    };

    const { after } = await migrated([body]);

    expect(after[0]?.content).toEqual({
      version: 1,
      blocks: [
        button(builtIn("requestAccount")),
        button({ kind: "page", pageId: "built-in-news" }),
      ],
    });
  });

  it("leaves something stored by a plugin's block, which is the plugin's to read", async () => {
    const poll = {
      type: "example-plugin/poll",
      target: builtIn("news"),
    };

    const { after } = await migrated([
      { version: 1, blocks: [poll, button(builtIn("news"))] },
    ]);

    expect(after[0]?.content).toEqual({
      version: 1,
      blocks: [poll, button({ kind: "page", pageId: "built-in-news" })],
    });
  });
});

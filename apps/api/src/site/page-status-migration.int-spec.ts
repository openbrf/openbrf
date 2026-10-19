import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { scratchDatabases, withClient } from "../testing/scratch-databases";

/**
 * The migration that gives a page one status and an explicit front page, run
 * against the pages an older version stored.
 *
 * The template the other suites run against has this migration applied to an
 * empty table, which proves nothing about the rows an association already has.
 * So a scratch database is brought up to the migration before this one, as an
 * instance meets it on the day it upgrades; each case writes pages and menu
 * entries in the shape that version wrote them, runs this migration's SQL, and
 * reads back what it made of them. Every case runs in a transaction that is
 * rolled back, so the next one starts from the old shape again.
 */

const MIGRATION_NAME = "20261018100100_page_status_and_front_page";

const migrations = join(process.cwd(), "prisma", "migrations");

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(migrations, MIGRATION_NAME, "migration.sql"),
  "utf8",
);

const scratch = scratchDatabases();
let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await scratch.create("page_status");
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

/** A page as the version before this one stored it. */
interface OldPage {
  id: string;
  slug?: string;
  published: boolean;
  visibility: "PUBLIC" | "MEMBER";
  publishedAt?: string | null;
  sortOrder?: number;
  createdAt?: string;
}

/** A menu entry as that version stored it. */
interface OldMenuItem {
  id: string;
  kind: "PAGE" | "GENERATED" | "EXTERNAL";
  pageId?: string;
  parentId?: string;
  sortOrder: number;
}

interface MigratedPage {
  id: string;
  status: string;
  frontPage: boolean;
  slugFollowsTitle: boolean;
  /** As the column stores it, without a zone: `2026-05-01 08:00:00`. */
  publishedAt: string | null;
}

/** Thrown to roll a case's transaction back once it has read its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back");
  }
}

/**
 * Writes the rows, runs the migration and hands the client to `read` inside
 * one transaction, then rolls everything back.
 */
async function migrated<T>(
  pages: readonly OldPage[],
  menu: readonly OldMenuItem[],
  read: (client: Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl, async (client) => {
    await client.query("BEGIN");
    try {
      for (const page of pages) {
        await client.query(
          `INSERT INTO "page" ("id", "slug", "title", "content", "visibility",
             "published", "publishedAt", "sortOrder", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, '{"version":1,"blocks":[]}', $4::"PageVisibility",
             $5, $6, $7, $8, now())`,
          [
            page.id,
            page.slug ?? page.id,
            `Sida ${page.id}`,
            page.visibility,
            page.published,
            page.publishedAt ?? null,
            page.sortOrder ?? 0,
            page.createdAt ?? "2026-09-01T00:00:00Z",
          ],
        );
      }
      for (const item of menu) {
        await client.query(
          `INSERT INTO "menu_item" ("id", "label", "kind", "pageId", "generatedKey",
             "parentId", "sortOrder", "updatedAt")
           VALUES ($1, $1, $2::"MenuItemKind", $3, $4, $5, $6, now())`,
          [
            item.id,
            item.kind,
            item.pageId ?? null,
            item.kind === "GENERATED" ? "news" : null,
            item.parentId ?? null,
            item.sortOrder,
          ],
        );
      }
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

async function pagesOf(client: Client): Promise<Map<string, MigratedPage>> {
  const { rows } = await client.query<MigratedPage>(
    `SELECT "id", "status"::text AS "status", "frontPage", "slugFollowsTitle",
            "publishedAt"::text AS "publishedAt"
     FROM "page"`,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/** The id of the page the migration chose as the front page, or null. */
async function frontPageOf(client: Client): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT "id" FROM "page" WHERE "frontPage"`,
  );
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0]?.id ?? null;
}

describe("the status a page is given", () => {
  const FIRST_PUBLISHED = "2026-05-01 08:00:00";

  it.each([
    [true, "PUBLIC", "PUBLIC"],
    [true, "MEMBER", "MEMBERS_ONLY"],
    [false, "PUBLIC", "DRAFT"],
    [false, "MEMBER", "DRAFT"],
  ] as const)(
    "reads published %s and visibility %s as %s, keeping when it was first published",
    async (published, visibility, status) => {
      const page = await migrated(
        [
          {
            id: "page-1",
            published,
            visibility,
            // A page taken down keeps the date it was first published.
            publishedAt: FIRST_PUBLISHED,
          },
        ],
        [],
        async (client) => (await pagesOf(client)).get("page-1"),
      );

      expect(page?.status).toBe(status);
      expect(page?.publishedAt).toBe(FIRST_PUBLISHED);
    },
  );

  it("keeps the address of every page it finds, and gives new pages one that follows the title", async () => {
    const answer = await migrated(
      [
        { id: "kept-public", published: true, visibility: "PUBLIC" },
        { id: "kept-draft", published: false, visibility: "PUBLIC" },
      ],
      [],
      async (client) => {
        await client.query(
          `INSERT INTO "page" ("id", "slug", "title", "content", "updatedAt")
           VALUES ('new', 'ny', 'Ny', '{"version":1,"blocks":[]}', now())`,
        );
        return pagesOf(client);
      },
    );

    // Each existing address was typed by the board, and a rename after the
    // upgrade must not move one - a draft's included.
    expect(answer.get("kept-public")?.slugFollowsTitle).toBe(false);
    expect(answer.get("kept-draft")?.slugFollowsTitle).toBe(false);
    expect(answer.get("new")).toMatchObject({
      slugFollowsTitle: true,
      status: "DRAFT",
      frontPage: false,
    });
  });

  it("drops the two columns the status replaces", async () => {
    const columns = await migrated([], [], async (client) => {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'page'`,
      );
      return rows.map((row) => row.column_name);
    });

    expect(columns).not.toContain("published");
    expect(columns).not.toContain("visibility");
    expect(columns).toEqual(
      expect.arrayContaining(["status", "frontPage", "slugFollowsTitle"]),
    );
  });
});

describe("the front page it chooses", () => {
  it("is the menu's first page entry anybody may read, as the root served it", async () => {
    const front = await migrated(
      [
        // Lowest in the board's list, and not in the menu: the menu decided.
        { id: "first-in-list", published: true, visibility: "PUBLIC" },
        {
          id: "draft",
          published: false,
          visibility: "PUBLIC",
          sortOrder: 1,
        },
        { id: "members", published: true, visibility: "MEMBER", sortOrder: 2 },
        { id: "home", published: true, visibility: "PUBLIC", sortOrder: 3 },
        { id: "later", published: true, visibility: "PUBLIC", sortOrder: 4 },
      ],
      [
        // A draft and a members' page come first, and are passed over.
        { id: "m-draft", kind: "PAGE", pageId: "draft", sortOrder: 0 },
        { id: "m-members", kind: "PAGE", pageId: "members", sortOrder: 1 },
        { id: "m-home", kind: "PAGE", pageId: "home", sortOrder: 2 },
        { id: "m-later", kind: "PAGE", pageId: "later", sortOrder: 3 },
      ],
      frontPageOf,
    );

    expect(front).toBe("home");
  });

  it("reaches into a dropdown before moving on to the next entry", async () => {
    const front = await migrated(
      [
        { id: "under", published: true, visibility: "PUBLIC", sortOrder: 9 },
        { id: "next", published: true, visibility: "PUBLIC", sortOrder: 0 },
      ],
      [
        // A generated entry at the top, with the page hanging under it.
        { id: "m-news", kind: "GENERATED", sortOrder: 0 },
        {
          id: "m-under",
          kind: "PAGE",
          pageId: "under",
          parentId: "m-news",
          sortOrder: 5,
        },
        { id: "m-next", kind: "PAGE", pageId: "next", sortOrder: 1 },
      ],
      frontPageOf,
    );

    expect(front).toBe("under");
  });

  it("passes over an entry hanging two levels down, which is never rendered", async () => {
    const front = await migrated(
      [
        { id: "deep", published: true, visibility: "PUBLIC", sortOrder: 0 },
        { id: "shown", published: true, visibility: "PUBLIC", sortOrder: 1 },
      ],
      [
        { id: "m-top", kind: "GENERATED", sortOrder: 0 },
        { id: "m-mid", kind: "EXTERNAL", parentId: "m-top", sortOrder: 0 },
        {
          id: "m-deep",
          kind: "PAGE",
          pageId: "deep",
          parentId: "m-mid",
          sortOrder: 0,
        },
        { id: "m-shown", kind: "PAGE", pageId: "shown", sortOrder: 1 },
      ],
      frontPageOf,
    );

    expect(front).toBe("shown");
  });

  it("falls back to the lowest public page in the list, never the privacy notice", async () => {
    const front = await migrated(
      [
        {
          id: "notice",
          slug: "integritetspolicy",
          published: true,
          visibility: "PUBLIC",
          sortOrder: 0,
        },
        { id: "members", published: true, visibility: "MEMBER", sortOrder: 0 },
        { id: "higher", published: true, visibility: "PUBLIC", sortOrder: 2 },
        // Ties with the next on order, and is older.
        {
          id: "lowest",
          published: true,
          visibility: "PUBLIC",
          sortOrder: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "younger",
          published: true,
          visibility: "PUBLIC",
          sortOrder: 1,
          createdAt: "2026-06-01T00:00:00Z",
        },
      ],
      // A menu naming no page anybody may read.
      [{ id: "m-members", kind: "PAGE", pageId: "members", sortOrder: 0 }],
      frontPageOf,
    );

    expect(front).toBe("lowest");
  });

  it("chooses none on an instance with no public page, which the root answers as before", async () => {
    const front = await migrated(
      [
        { id: "draft", published: false, visibility: "PUBLIC" },
        { id: "members", published: true, visibility: "MEMBER" },
      ],
      [{ id: "m-draft", kind: "PAGE", pageId: "draft", sortOrder: 0 }],
      frontPageOf,
    );

    expect(front).toBeNull();
  });
});

describe("what the table holds to afterwards", () => {
  const PAGES: OldPage[] = [
    { id: "home", published: true, visibility: "PUBLIC" },
    { id: "other", published: true, visibility: "PUBLIC", sortOrder: 1 },
  ];

  /** The SQLSTATE a statement fails with, or null if it succeeds. */
  async function failureOf(client: Client, sql: string): Promise<unknown> {
    await client.query("SAVEPOINT attempt");
    try {
      await client.query(sql);
      return null;
    } catch (error) {
      return (error as { code?: unknown }).code;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT attempt");
    }
  }

  it("refuses a second front page", async () => {
    const code = await migrated(PAGES, [], async (client) =>
      failureOf(
        client,
        `UPDATE "page" SET "frontPage" = true WHERE "id" = 'other'`,
      ),
    );

    // unique_violation
    expect(code).toBe("23505");
  });

  it.each(["DRAFT", "MEMBERS_ONLY"])(
    "refuses a front page that is %s",
    async (status) => {
      const code = await migrated(PAGES, [], async (client) =>
        failureOf(
          client,
          `UPDATE "page" SET "status" = '${status}' WHERE "id" = 'home'`,
        ),
      );

      // check_violation
      expect(code).toBe("23514");
    },
  );
});

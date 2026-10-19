import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { scratchDatabases, withClient } from "../testing/scratch-databases";

/**
 * The migration that makes the news index, the calendar, the broker
 * information page and the account request form built-in pages, run against
 * the menus an older version stored.
 *
 * The promise is that every menu renders exactly as it did the day before. So
 * a scratch database is brought up to the migration before this one, as an
 * instance meets it on the day it upgrades; each case writes pages and menu
 * entries in the shape that version wrote them - generated entries named by a
 * key among them - runs this migration's SQL, and reads back what it made of
 * them. Every case runs in a transaction that is rolled back, so the next one
 * starts from the old shape again.
 */

const MIGRATION_NAME = "20261019100000_built_in_pages";

const migrations = join(process.cwd(), "prisma", "migrations");

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(migrations, MIGRATION_NAME, "migration.sql"),
  "utf8",
);

const scratch = scratchDatabases();
let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await scratch.create("built_in_pages");
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
  status?: "DRAFT" | "MEMBERS_ONLY" | "PUBLIC";
  sortOrder?: number;
}

/** A menu entry as that version stored it. */
interface OldMenuItem {
  id: string;
  label?: string;
  kind: "PAGE" | "GENERATED" | "EXTERNAL";
  pageId?: string;
  generatedKey?: string;
  url?: string;
  parentId?: string;
  sortOrder: number;
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
  setup: {
    pages?: readonly OldPage[];
    menu?: readonly OldMenuItem[];
    locale?: string;
  },
  read: (client: Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl, async (client) => {
    await client.query("BEGIN");
    try {
      if (setup.locale !== undefined) {
        await client.query(
          `INSERT INTO "association" ("id", "name", "defaultLocale", "updatedAt")
           VALUES (1, 'Brf Talgoxen', $1, now())`,
          [setup.locale],
        );
      }
      for (const page of setup.pages ?? []) {
        await client.query(
          `INSERT INTO "page" ("id", "slug", "title", "content", "status",
             "slugFollowsTitle", "sortOrder", "updatedAt")
           VALUES ($1, $2, $3, '{"version":1,"blocks":[]}',
             $4::"PageStatus", false, $5, now())`,
          [
            page.id,
            page.slug ?? page.id,
            `Sida ${page.id}`,
            page.status ?? "PUBLIC",
            page.sortOrder ?? 0,
          ],
        );
      }
      for (const item of setup.menu ?? []) {
        await client.query(
          `INSERT INTO "menu_item" ("id", "label", "kind", "pageId", "generatedKey",
             "url", "parentId", "sortOrder", "updatedAt")
           VALUES ($1, $2, $3::"MenuItemKind", $4, $5, $6, $7, $8, now())`,
          [
            item.id,
            item.label ?? item.id,
            item.kind,
            item.pageId ?? null,
            item.generatedKey ?? null,
            item.url ?? null,
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

/**
 * The menu as the website renders it, read the way MenuService reads it: in
 * order, each entry's label and the address it leads to.
 *
 * Read from the new shape, and compared with what the old renderer produced
 * from the old one: a generated entry led to the address its key named, and a
 * page entry to the page's own.
 */
async function menuOf(
  client: Client,
): Promise<
  { id: string; label: string; parentId: string | null; href: string }[]
> {
  const { rows } = await client.query<{
    id: string;
    label: string;
    parentId: string | null;
    kind: string;
    url: string | null;
    slug: string | null;
  }>(
    `SELECT "menu_item"."id", "menu_item"."label", "menu_item"."parentId",
            "menu_item"."kind"::text AS "kind", "menu_item"."url", "page"."slug"
     FROM "menu_item"
     LEFT JOIN "page" ON "page"."id" = "menu_item"."pageId"
     ORDER BY "menu_item"."sortOrder", "menu_item"."createdAt", "menu_item"."id"`,
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    parentId: row.parentId,
    href: row.kind === "EXTERNAL" ? (row.url ?? "") : `/${row.slug ?? ""}`,
  }));
}

/** What the old renderer led each generated key to. */
const GENERATED_HREF = {
  news: "/nyheter",
  calendar: "/kalender",
  broker: "/maklarinfo",
  requestAccount: "/app/request-account",
} as const;

interface BuiltInRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  frontPage: boolean;
  slugFollowsTitle: boolean;
  builtIn: string;
  sortOrder: number;
  content: unknown;
}

async function builtInPagesOf(client: Client): Promise<BuiltInRow[]> {
  const { rows } = await client.query<BuiltInRow>(
    `SELECT "id", "slug", "title", "status"::text AS "status", "frontPage",
            "slugFollowsTitle", "builtIn"::text AS "builtIn", "sortOrder", "content"
     FROM "page" WHERE "builtIn" IS NOT NULL ORDER BY "sortOrder"`,
  );
  return rows;
}

describe("the menu an association already has", () => {
  it("renders every entry exactly as it did, a generated one of each key and an entry under each", async () => {
    const pages: OldPage[] = [
      { id: "home", slug: "hem" },
      { id: "about", slug: "om-foreningen", sortOrder: 1 },
      {
        id: "members",
        slug: "protokoll",
        status: "MEMBERS_ONLY",
        sortOrder: 2,
      },
    ];
    const menu: OldMenuItem[] = [
      { id: "m-home", kind: "PAGE", pageId: "home", sortOrder: 0 },
      // A generated entry with a dropdown of its own under it.
      {
        id: "m-news",
        label: "Aktuellt",
        kind: "GENERATED",
        generatedKey: "news",
        sortOrder: 1,
      },
      {
        id: "m-calendar",
        label: "Händer i huset",
        kind: "GENERATED",
        generatedKey: "calendar",
        parentId: "m-news",
        sortOrder: 0,
      },
      {
        id: "m-members",
        kind: "PAGE",
        pageId: "members",
        parentId: "m-news",
        sortOrder: 1,
      },
      // A page entry with a generated entry under it.
      { id: "m-about", kind: "PAGE", pageId: "about", sortOrder: 2 },
      {
        id: "m-broker",
        label: "För mäklare",
        kind: "GENERATED",
        generatedKey: "broker",
        parentId: "m-about",
        sortOrder: 0,
      },
      {
        id: "m-external",
        label: "Boverket",
        kind: "EXTERNAL",
        url: "https://boverket.invalid",
        sortOrder: 3,
      },
      {
        id: "m-request",
        label: "Bli medlem",
        kind: "GENERATED",
        generatedKey: "requestAccount",
        sortOrder: 4,
      },
    ];

    const after = await migrated({ pages, menu }, menuOf);

    const hrefOf = (item: OldMenuItem): string =>
      item.kind === "EXTERNAL"
        ? (item.url ?? "")
        : item.kind === "GENERATED"
          ? GENERATED_HREF[item.generatedKey as keyof typeof GENERATED_HREF]
          : `/${pages.find((page) => page.id === item.pageId)?.slug ?? ""}`;

    // The same entries, in the same order, under the same parents, saying the
    // same words and leading to the same addresses.
    expect(after).toEqual(
      [...menu]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map((item) => ({
          id: item.id,
          label: item.label ?? item.id,
          parentId: item.parentId ?? null,
          href: hrefOf(item),
        })),
    );
  });

  it("points each generated entry at its built-in page, as a page entry", async () => {
    const entries = await migrated(
      {
        menu: [
          {
            id: "m-news",
            kind: "GENERATED",
            generatedKey: "news",
            sortOrder: 0,
          },
          {
            id: "m-request",
            kind: "GENERATED",
            generatedKey: "requestAccount",
            sortOrder: 1,
          },
        ],
      },
      async (client) =>
        (
          await client.query<{ id: string; kind: string; builtIn: string }>(
            `SELECT "menu_item"."id", "menu_item"."kind"::text AS "kind",
                    "page"."builtIn"::text AS "builtIn"
             FROM "menu_item" JOIN "page" ON "page"."id" = "menu_item"."pageId"
             ORDER BY "menu_item"."sortOrder"`,
          )
        ).rows,
    );

    expect(entries).toEqual([
      { id: "m-news", kind: "PAGE", builtIn: "NEWS" },
      { id: "m-request", kind: "PAGE", builtIn: "REQUEST_ACCOUNT" },
    ]);
  });

  it("removes an entry naming a key no version offered, which was never rendered, with what hung under it", async () => {
    const after = await migrated(
      {
        pages: [{ id: "about" }],
        menu: [
          {
            id: "m-future",
            kind: "GENERATED",
            generatedKey: "framtiden",
            sortOrder: 0,
          },
          {
            id: "m-under",
            kind: "PAGE",
            pageId: "about",
            parentId: "m-future",
            sortOrder: 0,
          },
          { id: "m-about", kind: "PAGE", pageId: "about", sortOrder: 1 },
        ],
      },
      menuOf,
    );

    expect(after.map((entry) => entry.id)).toEqual(["m-about"]);
  });

  it("leaves the menu with two kinds of entry and no key column", async () => {
    const answer = await migrated({}, async (client) => {
      const kinds = await client.query<{ value: string }>(
        `SELECT unnest(enum_range(NULL::"MenuItemKind"))::text AS "value"`,
      );
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'menu_item'`,
      );
      return {
        kinds: kinds.rows.map((row) => row.value),
        columns: columns.rows.map((row) => row.column_name),
      };
    });

    expect(answer.kinds).toEqual(["PAGE", "EXTERNAL"]);
    expect(answer.columns).not.toContain("generatedKey");
  });
});

describe("the built-in pages it writes", () => {
  it("writes one of each, public, at the address it is served at and after every page there is", async () => {
    const built = await migrated(
      {
        pages: [
          { id: "home", sortOrder: 0 },
          // The privacy notice, seeded far down the list.
          { id: "notice", slug: "integritetspolicy", sortOrder: 1000 },
        ],
      },
      builtInPagesOf,
    );

    expect(built).toEqual([
      expect.objectContaining({
        builtIn: "NEWS",
        slug: "nyheter",
        title: "Nyheter",
        sortOrder: 1001,
      }),
      expect.objectContaining({
        builtIn: "CALENDAR",
        slug: "kalender",
        title: "Kalender",
        sortOrder: 1002,
      }),
      expect.objectContaining({
        builtIn: "BROKER_INFORMATION",
        slug: "maklarinfo",
        title: "Mäklarinfo",
        sortOrder: 1003,
      }),
      expect.objectContaining({
        builtIn: "REQUEST_ACCOUNT",
        slug: "app/request-account",
        title: "Ansök om konto",
        sortOrder: 1004,
      }),
    ]);
    for (const page of built) {
      expect(page).toMatchObject({
        status: "PUBLIC",
        frontPage: false,
        slugFollowsTitle: false,
        content: { version: 1, blocks: [] },
      });
    }
  });

  it("titles them in the association's own language where it has chosen one", async () => {
    const built = await migrated({ locale: "en" }, builtInPagesOf);

    expect(built.map((page) => page.title)).toEqual([
      "News",
      "Calendar",
      "Broker information",
      "Request an account",
    ]);
  });

  it("writes them on an instance with no page at all, as a new one is", async () => {
    const built = await migrated({}, builtInPagesOf);

    expect(built.map((page) => page.sortOrder)).toEqual([1, 2, 3, 4]);
  });

  it("moves a page the board wrote at one of their addresses, which nobody could open, out of the way", async () => {
    const answer = await migrated(
      { pages: [{ id: "old-calendar", slug: "kalender" }] },
      async (client) => ({
        old: (
          await client.query<{ slug: string }>(
            `SELECT "slug" FROM "page" WHERE "id" = 'old-calendar'`,
          )
        ).rows[0]?.slug,
        built: (await builtInPagesOf(client)).find(
          (page) => page.builtIn === "CALENDAR",
        )?.slug,
      }),
    );

    expect(answer).toEqual({
      old: "kalender-old-calendar",
      built: "kalender",
    });
  });
});

describe("what the table holds to afterwards", () => {
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

  it.each([
    [`"status" = 'DRAFT'`],
    [`"status" = 'MEMBERS_ONLY'`],
    [`"frontPage" = true`],
    [`"slugFollowsTitle" = true`],
  ])("refuses a built-in page set to %s", async (assignment) => {
    const code = await migrated({}, async (client) =>
      failureOf(
        client,
        `UPDATE "page" SET ${assignment} WHERE "builtIn" = 'NEWS'`,
      ),
    );

    // check_violation
    expect(code).toBe("23514");
  });

  it("refuses a second page of one kind", async () => {
    const code = await migrated({}, async (client) =>
      failureOf(
        client,
        `INSERT INTO "page" ("id", "slug", "title", "content", "status",
           "slugFollowsTitle", "builtIn", "updatedAt")
         VALUES ('again', 'nyheter-2', 'Nyheter', '{"version":1,"blocks":[]}',
           'PUBLIC', false, 'NEWS', now())`,
      ),
    );

    // unique_violation
    expect(code).toBe("23505");
  });
});

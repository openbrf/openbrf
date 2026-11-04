import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { scratchDatabases, withClient } from "../testing/scratch-databases";

/**
 * The migration that gives an issue its two layers (ADR 0057), run against
 * the rows the version before it stored.
 *
 * A scratch database is brought up to every migration before this one, and
 * each case writes an association, a type and issues in that shape, runs this
 * migration's SQL, and reads back what it made of them, in a transaction that
 * is rolled back so the next case starts from the old shape again.
 *
 * What it holds the migration to: every issue keeps its text, its messages and
 * its dates; an issue in a DONE status that has no closing date is given one,
 * because the clock runs from it and an issue without one would keep its free
 * text for ever; the board starts at two years; and a redaction mark can only
 * stand over an empty text.
 */

const MIGRATION_NAME = "20261104090100_issue_two_layer_retention";

const migrations = join(process.cwd(), "prisma", "migrations");

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(migrations, MIGRATION_NAME, "migration.sql"),
  "utf8",
);

const scratch = scratchDatabases();
let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await scratch.create("issue_two_layers");
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
 * Writes an association, one type with a status of each meaning and the
 * issues given, runs the migration, and hands the client to `read` inside one
 * transaction, then rolls everything back.
 */
async function migrated<T>(
  issues: readonly {
    id: string;
    meaning: "NEW" | "IN_PROGRESS" | "DONE";
    closedAt: string | null;
    updatedAt: string;
    message?: string;
  }[],
  read: (client: Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO "association" ("id", "name", "updatedAt")
         VALUES (1, 'Brf Talgoxen', now())`,
      );
      await client.query(
        `INSERT INTO "issue_type" ("id", "name", "reporters", "updatedAt")
         VALUES ('type-1', 'Vatten', ARRAY['RESIDENTS']::"IssueReporterGroup"[], now())`,
      );
      for (const meaning of ["NEW", "IN_PROGRESS", "WAITING", "DONE"]) {
        await client.query(
          `INSERT INTO "issue_status" ("id", "typeId", "meaning", "label",
             "isDefault", "updatedAt")
           VALUES ($1, 'type-1', $2::"IssueStatusMeaning", $2, true, now())`,
          [`status-${meaning}`, meaning],
        );
      }
      for (const issue of issues) {
        await client.query(
          `INSERT INTO "issue" ("id", "typeId", "statusId", "description",
             "location", "closedAt", "updatedAt")
           VALUES ($1, 'type-1', $2, 'Det droppar', 'Badrummet', $3, $4)`,
          [
            issue.id,
            `status-${issue.meaning}`,
            issue.closedAt,
            issue.updatedAt,
          ],
        );
        if (issue.message !== undefined) {
          await client.query(
            `INSERT INTO "issue_message" ("id", "issueId", "side", "body")
             VALUES ($1, $2, 'REPORTER', $3)`,
            [`message-${issue.id}`, issue.id, issue.message],
          );
        }
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

describe("the two-layer migration", () => {
  it("keeps every issue's text, and dates a closed issue that had no closing date", async () => {
    const rows = await migrated(
      [
        {
          id: "closed-dated",
          meaning: "DONE",
          closedAt: "2024-02-01T10:00:00Z",
          updatedAt: "2024-03-01T10:00:00Z",
          message: "Tack!",
        },
        {
          id: "closed-undated",
          meaning: "DONE",
          closedAt: null,
          updatedAt: "2023-05-04T10:00:00Z",
        },
        {
          id: "open",
          meaning: "IN_PROGRESS",
          closedAt: null,
          updatedAt: "2025-01-01T10:00:00Z",
        },
      ],
      async (client) =>
        (
          await client.query<{
            id: string;
            description: string;
            location: string | null;
            closedAt: string | null;
            descriptionRedactedAt: Date | null;
            freeTextRemovedAt: Date | null;
            legalHoldAt: Date | null;
            messages: string;
          }>(
            // As text: the column has no time zone, and the driver would read
            // it in the machine's own.
            `SELECT i."id", i."description", i."location",
               i."closedAt"::text AS "closedAt",
               i."descriptionRedactedAt", i."freeTextRemovedAt",
               i."legalHoldAt",
               (SELECT count(*) FROM "issue_message" m
                WHERE m."issueId" = i."id") AS "messages"
             FROM "issue" i ORDER BY i."id"`,
          )
        ).rows,
    );

    expect(rows).toEqual([
      {
        id: "closed-dated",
        description: "Det droppar",
        location: "Badrummet",
        closedAt: "2024-02-01 10:00:00",
        descriptionRedactedAt: null,
        freeTextRemovedAt: null,
        legalHoldAt: null,
        messages: "1",
      },
      {
        // The date of its last change, which is when it last moved.
        id: "closed-undated",
        description: "Det droppar",
        location: "Badrummet",
        closedAt: "2023-05-04 10:00:00",
        descriptionRedactedAt: null,
        freeTextRemovedAt: null,
        legalHoldAt: null,
        messages: "0",
      },
      {
        id: "open",
        description: "Det droppar",
        location: "Badrummet",
        closedAt: null,
        descriptionRedactedAt: null,
        freeTextRemovedAt: null,
        legalHoldAt: null,
        messages: "0",
      },
    ]);
  });

  it("starts the board at two years, and refuses a clock outside one to ten", async () => {
    const answer = await migrated([], async (client) => {
      const { rows } = await client.query<{ years: number }>(
        `SELECT "issueTextRetentionYears" AS "years" FROM "association"`,
      );
      await client.query("SAVEPOINT bounds");
      const refused = await client
        .query(`UPDATE "association" SET "issueTextRetentionYears" = 11`)
        .then(
          () => false,
          () => true,
        );
      await client.query("ROLLBACK TO SAVEPOINT bounds");
      return { years: rows[0]?.years, refused };
    });
    expect(answer).toEqual({ years: 2, refused: true });
  });

  it("lets a redaction mark stand only over an empty text", async () => {
    const answer = await migrated(
      [
        {
          id: "issue-1",
          meaning: "NEW",
          closedAt: null,
          updatedAt: "2025-01-01T10:00:00Z",
          message: "Ring mig på 070",
        },
      ],
      async (client) => {
        const attempt = async (sql: string): Promise<boolean> => {
          await client.query("SAVEPOINT attempt");
          return client.query(sql).then(
            async () => {
              await client.query("RELEASE SAVEPOINT attempt");
              return true;
            },
            async () => {
              await client.query("ROLLBACK TO SAVEPOINT attempt");
              return false;
            },
          );
        };
        return {
          markOverText: await attempt(
            `UPDATE "issue_message" SET "redactedAt" = now()`,
          ),
          emptyWithoutMark: await attempt(
            `UPDATE "issue_message" SET "body" = ''`,
          ),
          descriptionMarkOverText: await attempt(
            `UPDATE "issue" SET "descriptionRedactedAt" = now()`,
          ),
          redacted: await attempt(
            `UPDATE "issue_message" SET "redactedAt" = now(), "body" = ''`,
          ),
          descriptionRedacted: await attempt(
            `UPDATE "issue" SET "descriptionRedactedAt" = now(), "description" = '',
               "locationRedactedAt" = now(), "location" = NULL`,
          ),
        };
      },
    );
    expect(answer).toEqual({
      markOverText: false,
      emptyWithoutMark: false,
      descriptionMarkOverText: false,
      redacted: true,
      descriptionRedacted: true,
    });
  });
});

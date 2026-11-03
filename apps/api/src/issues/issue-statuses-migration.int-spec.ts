import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { scratchDatabases, withClient } from "../testing/scratch-databases";

/**
 * The migration that makes issue types and statuses data (ADR 0054), run
 * against the rows an older version stored.
 *
 * The template the other suites run against has this migration applied to
 * empty tables, which proves nothing about an association's queue. So a
 * scratch database is brought up to the migration before this one - the one
 * that adds the WAITING meaning, committed on its own as an instance meets it -
 * and each case writes types, issues and audit entries in the shape that
 * version wrote them, runs this migration's SQL, and reads back what it made of
 * them. Every case runs in a transaction that is rolled back, so the next one
 * starts from the old shape again.
 *
 * What it holds the migration to: every issue keeps its meaning, its closing
 * date and its history; duplicates of a name merge only with duplicates that
 * agree on being switched on; no closed issue is given an outcome nobody
 * decided; and every type works with no setup afterwards.
 */

const MIGRATION_NAME = "20261102090100_issue_statuses_as_data";

const migrations = join(process.cwd(), "prisma", "migrations");

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(migrations, MIGRATION_NAME, "migration.sql"),
  "utf8",
);

const scratch = scratchDatabases();
let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await scratch.create("issue_statuses");
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

/** A type as the version before this one stored it. */
interface OldType {
  id: string;
  name: string;
  audience: "NON_MEMBER" | "MEMBER" | "BOARD";
  active?: boolean;
  sortOrder?: number;
  createdAt?: string;
}

/** An issue as that version stored it. */
interface OldIssue {
  id: string;
  typeId: string;
  status: "NEW" | "IN_PROGRESS" | "DONE";
  closedAt?: string | null;
  reporterPersonId?: string | null;
  createdAt?: string;
}

/** A status change as that version recorded it. */
interface OldEntry {
  id: string;
  issueId: string;
  from: string;
  to: string;
}

interface Before {
  association?: { locale: string } | null;
  types: readonly OldType[];
  issues?: readonly OldIssue[];
  entries?: readonly OldEntry[];
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
  before: Before,
  read: (client: Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl, async (client) => {
    await client.query("BEGIN");
    try {
      if (before.association !== null) {
        await client.query(
          `INSERT INTO "association" ("id", "name", "defaultLocale", "updatedAt")
           VALUES (1, 'Brf Talgoxen', $1, now())`,
          [before.association?.locale ?? "sv"],
        );
      }
      for (const type of before.types) {
        await client.query(
          `INSERT INTO "issue_type" ("id", "name", "audience", "active",
             "sortOrder", "createdAt", "updatedAt")
           VALUES ($1, $2, $3::"IssueAudience", $4, $5, $6, now())`,
          [
            type.id,
            type.name,
            type.audience,
            type.active ?? true,
            type.sortOrder ?? 0,
            type.createdAt ?? "2026-09-01T00:00:00Z",
          ],
        );
      }
      for (const issue of before.issues ?? []) {
        await client.query(
          `INSERT INTO "issue" ("id", "typeId", "status", "reporterPersonId",
             "description", "closedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3::"IssueStatus", $4, $5, $6, $7, '2026-10-01T00:00:00Z')`,
          [
            issue.id,
            issue.typeId,
            issue.status,
            issue.reporterPersonId ?? null,
            `Beskrivning av ${issue.id}`,
            issue.closedAt ?? null,
            issue.createdAt ?? "2026-09-15T08:00:00Z",
          ],
        );
      }
      for (const entry of before.entries ?? []) {
        await client.query(
          `INSERT INTO "audit_log_entry" ("id", "action", "channel",
             "targetKind", "targetId", "context", "createdAt")
           VALUES ($1, 'ISSUE_STATUS_CHANGED', 'WEB', 'issue', $2, $3, now())`,
          [
            entry.id,
            entry.issueId,
            JSON.stringify({ from: entry.from, to: entry.to }),
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

interface MigratedType {
  id: string;
  name: string;
  reporters: string[];
  active: boolean;
  sortOrder: number;
}

async function typesOf(client: Client): Promise<MigratedType[]> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    reporters: string;
    active: boolean;
    sortOrder: number;
  }>(
    `SELECT "id", "name", "reporters"::text AS "reporters", "active", "sortOrder"
     FROM "issue_type"`,
  );
  // An enum array reads back as its text form, "{PUBLIC,RESIDENTS}". Sorted
  // here by code point rather than by the database's collation.
  return rows
    .map((row) => ({
      ...row,
      reporters: row.reporters.replace(/[{}]/g, "").split(",").filter(Boolean),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

interface MigratedIssue {
  id: string;
  typeId: string;
  meaning: string;
  label: string;
  isDefault: boolean;
  statusTypeId: string;
  waitingReason: string | null;
  outcome: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

async function issuesOf(client: Client): Promise<Map<string, MigratedIssue>> {
  const { rows } = await client.query<MigratedIssue>(
    `SELECT "issue"."id", "issue"."typeId", "status"."meaning"::text AS "meaning",
            "status"."label", "status"."isDefault",
            "status"."typeId" AS "statusTypeId",
            "issue"."waitingReason"::text AS "waitingReason",
            "issue"."outcome"::text AS "outcome",
            "issue"."closedAt"::text AS "closedAt",
            "issue"."createdAt"::text AS "createdAt",
            "issue"."updatedAt"::text AS "updatedAt"
     FROM "issue" JOIN "issue_status" AS "status" ON "status"."id" = "issue"."statusId"`,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function statusesOf(
  client: Client,
  typeId: string,
): Promise<[string, string, boolean, boolean][]> {
  const { rows } = await client.query<{
    meaning: string;
    label: string;
    isDefault: boolean;
    active: boolean;
  }>(
    `SELECT "meaning"::text AS "meaning", "label", "isDefault", "active"
     FROM "issue_status" WHERE "typeId" = $1
     ORDER BY array_position(ARRAY['NEW','IN_PROGRESS','WAITING','DONE'], "meaning"::text)`,
    [typeId],
  );
  return rows.map((row) => [row.meaning, row.label, row.isDefault, row.active]);
}

/**
 * A queue shaped as an association's after a year: one name offered on the
 * website and in the application as two rows, a third row of the same name the
 * board had switched off, a fourth switched off for residents, an internal
 * type, and issues in each of the three old statuses, some closed and some
 * with history.
 */
const REALISTIC: Before = {
  types: [
    {
      id: "hiss-members",
      name: "Hiss",
      audience: "MEMBER",
      sortOrder: 2,
      createdAt: "2026-01-02T00:00:00Z",
    },
    {
      // Trailing space: the board typed it twice, slightly differently.
      id: "hiss-public",
      name: "Hiss ",
      audience: "NON_MEMBER",
      sortOrder: 5,
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "hiss-board-off",
      name: "Hiss",
      audience: "BOARD",
      active: false,
      sortOrder: 7,
    },
    {
      id: "hiss-members-off",
      name: "Hiss",
      audience: "MEMBER",
      active: false,
      sortOrder: 4,
    },
    { id: "tvatt", name: "Tvättstuga", audience: "MEMBER", sortOrder: 3 },
    { id: "internt", name: "Försäkring", audience: "BOARD", sortOrder: 9 },
    // Never used: it still needs statuses to work.
    { id: "unused", name: "Skadedjur", audience: "NON_MEMBER", sortOrder: 1 },
    // A different name in the same letters: not a duplicate.
    { id: "hissen", name: "Hissen", audience: "MEMBER", sortOrder: 6 },
  ],
  issues: [
    { id: "i-new-members", typeId: "hiss-members", status: "NEW" },
    {
      id: "i-done-public",
      typeId: "hiss-public",
      status: "DONE",
      closedAt: "2026-03-01T12:00:00Z",
    },
    {
      id: "i-progress-public",
      typeId: "hiss-public",
      status: "IN_PROGRESS",
    },
    {
      id: "i-done-board-off",
      typeId: "hiss-board-off",
      status: "DONE",
      closedAt: "2026-02-01T12:00:00Z",
    },
    {
      id: "i-new-members-off",
      typeId: "hiss-members-off",
      status: "NEW",
      reporterPersonId: "person-1",
    },
    {
      id: "i-progress-tvatt",
      typeId: "tvatt",
      status: "IN_PROGRESS",
      reporterPersonId: "person-2",
    },
    // Closed before the closing date existed: kept as it is.
    { id: "i-done-undated", typeId: "internt", status: "DONE" },
    { id: "i-new-hissen", typeId: "hissen", status: "NEW" },
  ],
  entries: [
    {
      id: "e-1",
      issueId: "i-done-public",
      from: "NEW",
      to: "IN_PROGRESS",
    },
    { id: "e-2", issueId: "i-done-public", from: "IN_PROGRESS", to: "DONE" },
    {
      id: "e-3",
      issueId: "i-progress-tvatt",
      from: "NEW",
      to: "IN_PROGRESS",
    },
  ],
};

describe("issue types after the migration", () => {
  it("merges same-named types that agree on being switched on, and no others", async () => {
    const types = await migrated(REALISTIC, typesOf);

    expect(types).toEqual([
      // The switched-on duplicates, into the first of them in the board's
      // order, with the union of who could report them: the website's and the
      // residents'.
      {
        id: "hiss-members",
        name: "Hiss",
        reporters: ["PUBLIC", "RESIDENTS"],
        active: true,
        sortOrder: 2,
      },
      // The switched-off duplicates likewise, kept apart from them, so an
      // audience the board had closed stays closed.
      {
        id: "hiss-members-off",
        name: "Hiss",
        reporters: ["RESIDENTS", "HANDLERS"],
        active: false,
        sortOrder: 4,
      },
      {
        id: "hissen",
        name: "Hissen",
        reporters: ["RESIDENTS"],
        active: true,
        sortOrder: 6,
      },
      {
        id: "internt",
        name: "Försäkring",
        reporters: ["HANDLERS"],
        active: true,
        sortOrder: 9,
      },
      {
        id: "tvatt",
        name: "Tvättstuga",
        reporters: ["RESIDENTS"],
        active: true,
        sortOrder: 3,
      },
      {
        id: "unused",
        name: "Skadedjur",
        reporters: ["PUBLIC"],
        active: true,
        sortOrder: 1,
      },
    ]);
  });

  it("gives every type one default status of each meaning, in the association's language", async () => {
    const statuses = await migrated(REALISTIC, async (client) => {
      const types = await typesOf(client);
      return Promise.all(
        types.map(async (type) => statusesOf(client, type.id)),
      );
    });

    expect(statuses).toHaveLength(6);
    for (const typeStatuses of statuses) {
      expect(typeStatuses).toEqual([
        ["NEW", "Ny", true, true],
        ["IN_PROGRESS", "Pågår", true, true],
        ["WAITING", "Väntar", true, true],
        ["DONE", "Klar", true, true],
      ]);
    }
  });

  it("names them in English for an association the wizard set to English", async () => {
    const statuses = await migrated(
      { association: { locale: "en" }, types: [REALISTIC.types[0] as OldType] },
      (client) => statusesOf(client, "hiss-members"),
    );

    expect(statuses.map(([meaning, label]) => [meaning, label])).toEqual([
      ["NEW", "New"],
      ["IN_PROGRESS", "In progress"],
      ["WAITING", "Waiting"],
      ["DONE", "Done"],
    ]);
  });

  it("names them in Swedish on an instance whose wizard has not run", async () => {
    const statuses = await migrated(
      { association: null, types: [REALISTIC.types[0] as OldType] },
      (client) => statusesOf(client, "hiss-members"),
    );

    expect(statuses.map(([, label]) => label)).toEqual([
      "Ny",
      "Pågår",
      "Väntar",
      "Klar",
    ]);
  });
});

describe("issues after the migration", () => {
  it("keeps every issue, in the meaning its status named, on its type's default status", async () => {
    const issues = await migrated(REALISTIC, issuesOf);

    expect(issues.size).toBe(REALISTIC.issues?.length);
    expect(
      [...issues.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((issue) => [issue.id, issue.typeId, issue.meaning, issue.label]),
    ).toEqual([
      ["i-done-board-off", "hiss-members-off", "DONE", "Klar"],
      ["i-done-public", "hiss-members", "DONE", "Klar"],
      ["i-done-undated", "internt", "DONE", "Klar"],
      ["i-new-hissen", "hissen", "NEW", "Ny"],
      ["i-new-members", "hiss-members", "NEW", "Ny"],
      ["i-new-members-off", "hiss-members-off", "NEW", "Ny"],
      ["i-progress-public", "hiss-members", "IN_PROGRESS", "Pågår"],
      ["i-progress-tvatt", "tvatt", "IN_PROGRESS", "Pågår"],
    ]);
    for (const issue of issues.values()) {
      // A status of the issue's own type, and the default of its meaning.
      expect(issue.statusTypeId, issue.id).toBe(issue.typeId);
      expect(issue.isDefault, issue.id).toBe(true);
      expect(issue.waitingReason, issue.id).toBeNull();
    }
  });

  it("keeps each closing date and gives no closed issue an outcome", async () => {
    const issues = await migrated(REALISTIC, issuesOf);

    // Nobody decided how these ended, so the platform does not say (ADR 0054).
    expect([...issues.values()].map((issue) => issue.outcome)).toEqual(
      [...issues.values()].map(() => null),
    );
    expect(issues.get("i-done-public")?.closedAt).toBe("2026-03-01 12:00:00");
    expect(issues.get("i-done-board-off")?.closedAt).toBe(
      "2026-02-01 12:00:00",
    );
    expect(issues.get("i-done-undated")?.closedAt).toBeNull();
    expect(issues.get("i-new-members")?.closedAt).toBeNull();
  });

  it("leaves when each was reported and last changed as they were", async () => {
    const issues = await migrated(REALISTIC, issuesOf);

    for (const issue of issues.values()) {
      expect(issue.createdAt, issue.id).toBe("2026-09-15 08:00:00");
      expect(issue.updatedAt, issue.id).toBe("2026-10-01 00:00:00");
    }
  });

  it("leaves the history in the audit log as it was, still reading as meanings", async () => {
    const entries = await migrated(REALISTIC, async (client) => {
      const { rows } = await client.query<{
        id: string;
        targetId: string;
        context: unknown;
      }>(
        `SELECT "id", "targetId", "context" FROM "audit_log_entry"
         WHERE "action" = 'ISSUE_STATUS_CHANGED' ORDER BY "id"`,
      );
      return rows;
    });

    expect(entries).toEqual([
      {
        id: "e-1",
        targetId: "i-done-public",
        context: { from: "NEW", to: "IN_PROGRESS" },
      },
      {
        id: "e-2",
        targetId: "i-done-public",
        context: { from: "IN_PROGRESS", to: "DONE" },
      },
      {
        id: "e-3",
        targetId: "i-progress-tvatt",
        context: { from: "NEW", to: "IN_PROGRESS" },
      },
    ]);
  });

  it("refuses a status of another type, and an outcome on an open issue", async () => {
    const refusals = await migrated(REALISTIC, async (client) => {
      const attempt = async (sql: string): Promise<string> => {
        await client.query("SAVEPOINT attempt");
        try {
          await client.query(sql);
          return "accepted";
        } catch (error) {
          return (error as { constraint?: string }).constraint ?? "refused";
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT attempt");
        }
      };
      return {
        otherType: await attempt(
          `UPDATE "issue" SET "statusId" = (
             SELECT "id" FROM "issue_status" WHERE "typeId" = 'tvatt' AND "meaning" = 'NEW'
           ) WHERE "id" = 'i-new-members'`,
        ),
        openOutcome: await attempt(
          `UPDATE "issue" SET "outcome" = 'FIXED' WHERE "id" = 'i-new-members'`,
        ),
        secondDefault: await attempt(
          `INSERT INTO "issue_status" ("id", "typeId", "meaning", "label", "isDefault", "updatedAt")
           VALUES ('second-default', 'tvatt', 'NEW', 'Inkommen', true, now())`,
        ),
      };
    });

    expect(refusals).toEqual({
      otherType: "issue_statusId_typeId_fkey",
      openOutcome: "issue_outcome_only_closed",
      secondDefault: "issue_status_one_default",
    });
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";

/**
 * The migrations that hold an access weighing to one row per text and report
 * (ADR 0057), run against a real database as a database that took the
 * work-order migrations first meets them.
 *
 * Such a database has the `workOrderId` column and no unique index when
 * `20261110130000_issue_access_weighing_unique` runs out of order. That
 * migration names a message or a note and not a work order, so the migrations
 * on either side of it set the work orders' weighings aside and put them back
 * once the index tells one work order from another. Each case puts the table
 * back as that database had it, writes the weighings the earlier code could
 * have left, runs the migrations' SQL in the order Prisma would and reads what
 * they made of them. The template the suites run against has every migration
 * applied already, and every case runs in a transaction that is rolled back.
 */

const env = loadEnvForIntegrationTests();

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
function migration(name: string): string {
  return readFileSync(
    join(process.cwd(), "prisma", "migrations", name, "migration.sql"),
    "utf8",
  );
}

/**
 * The statements of a migration that wraps several in `BEGIN` and `COMMIT`,
 * which cannot run inside the case's transaction and cannot be sent as one
 * prepared statement. Neither of those migrations has a `;` but at the end of
 * a statement.
 */
function statements(name: string): readonly string[] {
  return migration(name)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement !== "" && statement !== "BEGIN" && statement !== "COMMIT",
    );
}

/** One statement each, run as the files are. */
const ASIDE = migration(
  "20261110125900_issue_access_weighing_work_orders_aside",
);
const BACK = migration("20261110140300_issue_access_weighing_work_orders_back");
const UNIQUE = statements("20261110130000_issue_access_weighing_unique");
const TEXT_KEY = statements(
  "20261110140200_issue_access_weighing_text_key_work_order",
);

const suffix = randomUUID().slice(0, 8);
const typeId = `awm-type-${suffix}`;

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

interface Weighing {
  id: string;
  concernedPersonId: string | null;
  part: string;
  workOrderId: string | null;
  withheldBecause: string | null;
  givenText: string | null;
  weighedAt: Date;
}

/** Thrown to roll a case's transaction back once it has read its answer. */
class RolledBack<T> extends Error {
  constructor(readonly value: T) {
    super("rolled back");
  }
}

let prisma: PrismaClient;
let type: IssueTypeFixture;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  type = await createIssueTypeFixture(prisma, {
    id: typeId,
    name: `Vattenskada ${suffix}`,
    reporters: ["RESIDENTS"],
  });
});

afterAll(async () => {
  await prisma.issue.deleteMany({ where: { typeId } });
  await prisma.issueType.deleteMany({ where: { id: typeId } });
  await prisma.$disconnect();
});

async function rolledBack<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await prisma.$transaction(async (tx) => {
      throw new RolledBack(await work(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.value as T;
    }
    throw error;
  }
  throw new Error("The transaction committed.");
}

interface Case {
  issueId: string;
  /** The record of whom the issue concerns, whose report the rows weigh. */
  concernedPersonId: string;
  workOrderIds: readonly string[];
}

/** An issue concerning one person, with `workOrders` work orders. */
async function issueWithWorkOrders(tx: Tx, workOrders: number): Promise<Case> {
  const issue = await tx.issue.create({
    data: {
      typeId,
      statusId: type.statusIds.DONE,
      outcome: "FIXED",
      priority: "NORMAL",
      location: null,
      description: "Vatten i källaren.",
      closedAt: new Date(),
    },
    select: { id: true },
  });
  const person = await tx.person.create({
    data: { firstName: "Nils", lastName: `Granne${suffix}` },
    select: { id: true },
  });
  const concerned = await tx.issueConcernedPerson.create({
    data: { issueId: issue.id, personId: person.id },
    select: { id: true },
  });
  const workOrderIds: string[] = [];
  for (let index = 0; index < workOrders; index += 1) {
    const order = await tx.workOrder.create({
      data: {
        issueId: issue.id,
        recipientName: `Rörmokare ${suffix}`,
        recipientEmailCipher: "kept-as-it-was",
        body: `Spola avloppet i trapphus ${String(index + 1)}.`,
      },
      select: { id: true },
    });
    workOrderIds.push(order.id);
  }
  return {
    issueId: issue.id,
    concernedPersonId: concerned.id,
    workOrderIds,
  };
}

/**
 * The table as a database that took the work-order migrations before the
 * uniqueness one had it: the column there, and no unique index yet.
 */
async function asBeforeTheUniqueIndex(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(`DROP INDEX "issue_access_weighing_text_key"`);
}

/** The migrations still pending there, in the order Prisma runs them. */
async function upgrade(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(ASIDE);
  for (const statement of UNIQUE) await tx.$executeRawUnsafe(statement);
  for (const statement of TEXT_KEY) await tx.$executeRawUnsafe(statement);
  await tx.$executeRawUnsafe(BACK);
}

function weighingsOf(tx: Tx, issueId: string): Promise<Weighing[]> {
  return tx.issueAccessWeighing.findMany({
    where: { issueId },
    select: {
      id: true,
      concernedPersonId: true,
      part: true,
      workOrderId: true,
      withheldBecause: true,
      givenText: true,
      weighedAt: true,
    },
    orderBy: { id: "asc" },
  });
}

async function asideTableLeft(tx: Tx): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`
    SELECT to_regclass('"issue_access_weighing_work_order_aside"') IS NOT NULL AS "found"
  `;
  return row?.found ?? true;
}

/**
 * Whether the table refuses a second weighing of the work order for the report,
 * tried behind a savepoint so a refusal leaves the case's transaction usable.
 */
async function refusesAnother(
  tx: Tx,
  at: Case,
  workOrderId: string,
): Promise<boolean> {
  await tx.$executeRawUnsafe("SAVEPOINT another");
  try {
    await tx.$executeRaw`
      INSERT INTO "issue_access_weighing"
        ("id", "issueId", "concernedPersonId", "part", "workOrderId")
      VALUES
        (${randomUUID()}, ${at.issueId}, ${at.concernedPersonId}, 'WORK_ORDER', ${workOrderId})
    `;
  } catch (error) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT another");
    expect(String(error)).toContain("issue_access_weighing_text_key");
    return true;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT another");
  return false;
}

describe("an upgrade from the work-order schema", () => {
  it("keeps each work order's own weighing, in both reports", async () => {
    const result = await rolledBack(async (tx) => {
      await asBeforeTheUniqueIndex(tx);
      const at = await issueWithWorkOrders(tx, 3);
      const [first, second, third] = at.workOrderIds as [
        string,
        string,
        string,
      ];
      const written = [
        {
          id: `awm-first-${suffix}`,
          concernedPersonId: at.concernedPersonId,
          workOrderId: first,
          withheldBecause: null,
          givenText: null,
          weighedAt: new Date("2026-11-10T09:00:00.000Z"),
        },
        {
          id: `awm-second-${suffix}`,
          concernedPersonId: at.concernedPersonId,
          workOrderId: second,
          withheldBecause: "ABOUT_ANOTHER_PERSON" as const,
          givenText: "Spola avloppet i [...].",
          weighedAt: new Date("2026-11-10T09:01:00.000Z"),
        },
        {
          id: `awm-third-${suffix}`,
          concernedPersonId: at.concernedPersonId,
          workOrderId: third,
          withheldBecause: "ABOUT_ANOTHER_PERSON" as const,
          givenText: null,
          weighedAt: new Date("2026-11-10T09:02:00.000Z"),
        },
        // The reporter's report weighs the same work order on its own.
        {
          id: `awm-reporter-${suffix}`,
          concernedPersonId: null,
          workOrderId: first,
          withheldBecause: "ABOUT_ANOTHER_PERSON" as const,
          givenText: null,
          weighedAt: new Date("2026-11-10T09:03:00.000Z"),
        },
      ];
      for (const row of written) {
        await tx.issueAccessWeighing.create({
          data: { issueId: at.issueId, part: "WORK_ORDER", ...row },
        });
      }
      await upgrade(tx);
      return {
        written,
        after: await weighingsOf(tx, at.issueId),
        asideTableLeft: await asideTableLeft(tx),
        refusesAnother: await refusesAnother(tx, at, second),
      };
    });

    expect(result.after).toEqual(
      result.written
        .map((row) => ({ ...row, part: "WORK_ORDER" }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(result.asideTableLeft).toBe(false);
    expect(result.refusesAnother).toBe(true);
  });

  it("leaves a work order weighed twice for one report unweighed, and the others as they were", async () => {
    const result = await rolledBack(async (tx) => {
      await asBeforeTheUniqueIndex(tx);
      const at = await issueWithWorkOrders(tx, 2);
      const [twice, once] = at.workOrderIds as [string, string];
      const base = {
        issueId: at.issueId,
        concernedPersonId: at.concernedPersonId,
        part: "WORK_ORDER" as const,
      };
      await tx.issueAccessWeighing.create({
        data: { ...base, id: `awm-twice-a-${suffix}`, workOrderId: twice },
      });
      await tx.issueAccessWeighing.create({
        data: {
          ...base,
          id: `awm-twice-b-${suffix}`,
          workOrderId: twice,
          withheldBecause: "ABOUT_ANOTHER_PERSON",
        },
      });
      await tx.issueAccessWeighing.create({
        data: { ...base, id: `awm-once-${suffix}`, workOrderId: once },
      });
      // The description weighed twice too, which the uniqueness migration
      // itself leaves unweighed.
      await tx.issueAccessWeighing.create({
        data: {
          ...base,
          id: `awm-description-a-${suffix}`,
          part: "DESCRIPTION",
        },
      });
      await tx.issueAccessWeighing.create({
        data: {
          ...base,
          id: `awm-description-b-${suffix}`,
          part: "DESCRIPTION",
          withheldBecause: "ABOUT_ANOTHER_PERSON",
        },
      });
      await upgrade(tx);
      const after = await weighingsOf(tx, at.issueId);
      return {
        ids: after.map((row) => row.id),
        refusesTheOnce: await refusesAnother(tx, at, once),
        // Unweighed now, so the board can weigh it once more, and once only.
        refusesTheTwiceOnce: await refusesAnother(tx, at, twice),
        asideTableLeft: await asideTableLeft(tx),
      };
    });

    expect(result.ids).toEqual([`awm-once-${suffix}`]);
    expect(result.refusesTheOnce).toBe(true);
    expect(result.refusesTheTwiceOnce).toBe(false);
    expect(result.asideTableLeft).toBe(false);
  });

  it("puts back a weighing whose work order is still there only", async () => {
    const result = await rolledBack(async (tx) => {
      await asBeforeTheUniqueIndex(tx);
      const at = await issueWithWorkOrders(tx, 2);
      const [kept, removed] = at.workOrderIds as [string, string];
      for (const workOrderId of at.workOrderIds) {
        await tx.issueAccessWeighing.create({
          data: {
            id: `awm-${workOrderId}`,
            issueId: at.issueId,
            concernedPersonId: at.concernedPersonId,
            part: "WORK_ORDER",
            workOrderId,
          },
        });
      }
      await tx.$executeRawUnsafe(ASIDE);
      // Gone while its weighing was set aside, out of reach of the key.
      await tx.workOrder.delete({ where: { id: removed } });
      for (const statement of UNIQUE) await tx.$executeRawUnsafe(statement);
      for (const statement of TEXT_KEY) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(BACK);
      return {
        kept,
        after: (await weighingsOf(tx, at.issueId)).map(
          (row) => row.workOrderId,
        ),
      };
    });

    expect(result.after).toEqual([result.kept]);
  });
});

describe("a database already holding the index that tells work orders apart", () => {
  it("comes through both migrations with its weighings as they were", async () => {
    const result = await rolledBack(async (tx) => {
      const at = await issueWithWorkOrders(tx, 2);
      for (const workOrderId of at.workOrderIds) {
        await tx.issueAccessWeighing.create({
          data: {
            id: `awm-${workOrderId}`,
            issueId: at.issueId,
            concernedPersonId: at.concernedPersonId,
            part: "WORK_ORDER",
            workOrderId,
          },
        });
      }
      const before = await weighingsOf(tx, at.issueId);
      // Pending there out of order, after every other migration.
      await tx.$executeRawUnsafe(ASIDE);
      await tx.$executeRawUnsafe(BACK);
      return {
        before,
        after: await weighingsOf(tx, at.issueId),
        asideTableLeft: await asideTableLeft(tx),
      };
    });

    expect(result.after).toEqual(result.before);
    expect(result.asideTableLeft).toBe(false);
  });
});

describe("a database built in the order of the migrations", () => {
  it("sets nothing aside before the work orders came, and puts nothing back", async () => {
    const result = await rolledBack(async (tx) => {
      const at = await issueWithWorkOrders(tx, 0);
      // The raw insert and read: the generated model selects the column this
      // case drops next.
      await tx.$executeRaw`
        INSERT INTO "issue_access_weighing"
          ("id", "issueId", "concernedPersonId", "part")
        VALUES
          (${`awm-description-${suffix}`}, ${at.issueId}, ${at.concernedPersonId}, 'DESCRIPTION')
      `;
      // As it stood when the uniqueness migration ran: no work orders weighed.
      await tx.$executeRawUnsafe(
        `ALTER TABLE "issue_access_weighing" DROP COLUMN "workOrderId"`,
      );
      await tx.$executeRawUnsafe(ASIDE);
      const asideAfterAside = await asideTableLeft(tx);
      await tx.$executeRawUnsafe(BACK);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "issue_access_weighing" WHERE "issueId" = ${at.issueId}
      `;
      return { asideAfterAside, ids: rows.map((row) => row.id) };
    });

    expect(result.asideAfterAside).toBe(false);
    expect(result.ids).toEqual([`awm-description-${suffix}`]);
  });
});

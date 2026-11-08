import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import type { IssueHandledBy, IssueReporterGroup } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { createIssueTypeFixture } from "../testing/issue-fixtures";

/**
 * The migration that hands an upgraded instance's existing type for
 * disturbances or for insurance to the board (decisions 13 and 32 of the issue
 * module's plan), run against a real database.
 *
 * The template the suites run against has had the migration applied already,
 * so each case writes the types and issues as an upgrade leaves them, runs the
 * migration's SQL again and reads back what it made of them. Everything a case
 * writes, its people included, is written in a transaction that is rolled back,
 * so a type named exactly as the migration looks for never outlives the case.
 */

const env = loadEnvForIntegrationTests();

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "prisma",
    "migrations",
    "20261108120000_issue_disturbance_and_insurance_types_board_only",
    "migration.sql",
  ),
  "utf8",
);

const suffix = randomUUID().slice(0, 8);

const boardMemberId = `bot-board-${suffix}`;
const formerBoardMemberId = `bot-former-${suffix}`;
const adminId = `bot-admin-${suffix}`;
const managerId = `bot-manager-${suffix}`;

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

interface TypeAfter {
  handledBy: IssueHandledBy;
  ringFenced: boolean;
  reporters: IssueReporterGroup[];
  active: boolean;
  defaultAssigneePersonId: string | null;
}

/** Thrown to roll a case's transaction back once it has read its answer. */
class RolledBack<T> extends Error {
  constructor(readonly found: T) {
    super("rolled back");
  }
}

let prisma: PrismaClient;

beforeAll(() => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Runs `scenario` in a transaction, which writes its rows, runs the migration
 * and reads them back, and returns what it read once the transaction is rolled
 * back.
 */
async function rolledBack<T>(scenario: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await prisma.$transaction(async (tx) => {
      throw new RolledBack(await scenario(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.found as T;
    }
    throw error;
  }
  throw new Error("The transaction committed.");
}

/**
 * The board member, a member whose seat has ended, the administrator and the
 * property manager, written inside the case's transaction.
 */
async function writePeople(tx: Tx): Promise<void> {
  for (const [id, firstName] of [
    [boardMemberId, "Bea"],
    [formerBoardMemberId, "Folke"],
    [adminId, "Ada"],
    [managerId, "Frida"],
  ] as const) {
    await tx.person.create({
      data: { id, firstName, lastName: `Testsson${suffix}` },
    });
  }
  await tx.boardPosition.create({
    data: {
      personId: boardMemberId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  await tx.boardPosition.create({
    data: {
      personId: formerBoardMemberId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2023-05-15"),
      endedOn: new Date("2025-05-15"),
    },
  });
  await tx.systemRole.createMany({
    data: [
      { personId: adminId, role: "ADMIN" },
      { personId: managerId, role: "PROPERTY_MANAGER" },
    ],
  });
}

/** Writes one type per name, as an upgrade leaves it, and answers their ids. */
async function writeTypes(
  tx: Tx,
  names: readonly string[],
  settings: {
    reporters?: readonly IssueReporterGroup[];
    active?: boolean;
    defaultAssigneePersonId?: string | null;
  } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const id = `bot-type-${suffix}-${randomUUID().slice(0, 8)}`;
    await createIssueTypeFixture(tx, {
      id,
      name,
      reporters: settings.reporters ?? ["RESIDENTS", "PUBLIC"],
      active: settings.active ?? true,
      handledBy: "EVERY_HANDLER",
      defaultAssigneePersonId: settings.defaultAssigneePersonId ?? null,
    });
    ids.push(id);
  }
  return ids;
}

async function readTypes(tx: Tx, ids: readonly string[]): Promise<TypeAfter[]> {
  const rows = await tx.issueType.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      handledBy: true,
      ringFenced: true,
      reporters: true,
      active: true,
      defaultAssigneePersonId: true,
    },
  });
  return ids.map((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      throw new Error("A type is gone.");
    }
    const { id: _id, ...after } = row;
    return after;
  });
}

/** The names the migration hands to the board, as boards have typed them. */
const MATCHED = [
  "Störningar",
  "störningar",
  "STÖRNINGAR",
  "Störning",
  " Störningar ",
  "Störningar\t",
  "Störningar\n",
  // The ö written as an o and a combining diaeresis, as some keyboards and
  // copied text leave it.
  "Störningar",
  "Försäkringsärende",
  "FÖRSÄKRINGSÄRENDE",
  "försäkringsärenden",
  "Försäkring",
] as const;

/** Names that contain or resemble those, which stay with every handler. */
const UNMATCHED = [
  "Driftstörningar",
  "Störningar i TV/bredband",
  "Störningsjour",
  "Störningar och buller",
  "Försäkringsfrågor",
  "Hemförsäkring",
  "Vattenläcka",
  "Disturbances",
  "Insurance",
  "Stö rningar",
] as const;

describe("an upgraded instance's type for disturbances or insurance", () => {
  it("is handed to the board by its exact name, and nothing is ring-fenced", async () => {
    const names = [...MATCHED, ...UNMATCHED];
    const after = await rolledBack(async (tx) => {
      await writePeople(tx);
      const ids = await writeTypes(tx, names);
      await tx.$executeRawUnsafe(MIGRATION);
      return readTypes(tx, ids);
    });

    expect(
      names.map((name, index) => ({
        name,
        handledBy: after[index]?.handledBy,
      })),
    ).toEqual([
      ...MATCHED.map((name) => ({ name, handledBy: "BOARD" })),
      ...UNMATCHED.map((name) => ({ name, handledBy: "EVERY_HANDLER" })),
    ]);
    // The ring-fence, the website's form and the switch stay the board's.
    for (const type of after) {
      expect(type.ringFenced).toBe(false);
      expect(type.reporters).toEqual(["RESIDENTS", "PUBLIC"]);
      expect(type.active).toBe(true);
    }
  });

  it("is handed over when it is switched off as well", async () => {
    const after = await rolledBack(async (tx) => {
      const ids = await writeTypes(tx, ["Störningar"], {
        active: false,
        reporters: ["PUBLIC"],
      });
      await tx.$executeRawUnsafe(MIGRATION);
      return readTypes(tx, ids);
    });

    expect(after).toEqual([
      {
        handledBy: "BOARD",
        ringFenced: false,
        reporters: ["PUBLIC"],
        active: false,
        defaultAssigneePersonId: null,
      },
    ]);
  });

  it("loses the property manager and a former board member as assignee, and keeps the board", async () => {
    const after = await rolledBack(async (tx) => {
      await writePeople(tx);
      const [disturbances] = await writeTypes(tx, ["Störningar"], {
        defaultAssigneePersonId: managerId,
      });
      const [insurance] = await writeTypes(tx, ["Försäkringsärende"], {
        defaultAssigneePersonId: boardMemberId,
      });
      const [leak] = await writeTypes(tx, ["Vattenläcka"], {
        defaultAssigneePersonId: managerId,
      });
      if (
        disturbances === undefined ||
        insurance === undefined ||
        leak === undefined
      ) {
        throw new Error("A type was not written.");
      }
      const assigned = async (typeId: string, assigneePersonId: string) => {
        const issue = await tx.issue.create({
          data: {
            typeId,
            statusId: `${typeId}-new`,
            priority: "NORMAL",
            location: null,
            description: `Anmälan ${suffix}`,
            assigneePersonId,
          },
          select: { id: true },
        });
        return issue.id;
      };
      const issues = {
        manager: await assigned(disturbances, managerId),
        former: await assigned(disturbances, formerBoardMemberId),
        board: await assigned(disturbances, boardMemberId),
        admin: await assigned(insurance, adminId),
        managerOnInsurance: await assigned(insurance, managerId),
        managerOnLeak: await assigned(leak, managerId),
      };

      await tx.$executeRawUnsafe(MIGRATION);

      const rows = await tx.issue.findMany({
        where: { id: { in: Object.values(issues) } },
        select: { id: true, assigneePersonId: true },
      });
      const types = await readTypes(tx, [disturbances, insurance, leak]);
      return {
        assignees: Object.fromEntries(
          Object.entries(issues).map(([key, id]) => [
            key,
            rows.find((row) => row.id === id)?.assigneePersonId,
          ]),
        ),
        defaultAssignees: types.map((type) => type.defaultAssigneePersonId),
      };
    });

    expect(after.assignees).toEqual({
      manager: null,
      former: null,
      board: boardMemberId,
      admin: adminId,
      managerOnInsurance: null,
      // A type that stays with every handler keeps its assignee.
      managerOnLeak: managerId,
    });
    expect(after.defaultAssignees).toEqual([null, boardMemberId, managerId]);
  });
});

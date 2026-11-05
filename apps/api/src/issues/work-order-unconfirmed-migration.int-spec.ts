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
 * The migration that records a work order's old "send-failed" as unconfirmed,
 * run against a real database.
 *
 * The code was written before the mail driver said whether an error came before
 * or after the handover, so a stored "send-failed" may be a message the server
 * took. The template the suites run against has had the migration applied
 * already, to a table with no work orders, so each case writes the rows as the
 * earlier code left them, runs the migration's SQL again and reads back what it
 * made of them. Every case runs in a transaction that is rolled back.
 */

const env = loadEnvForIntegrationTests();

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "prisma",
    "migrations",
    "20261105090000_work_order_unconfirmed_send_error",
    "migration.sql",
  ),
  "utf8",
);

const suffix = randomUUID().slice(0, 8);
const typeId = `wou-type-${suffix}`;

type Stored = {
  deliveryStatus: "PENDING" | "SENT" | "FAILED";
  deliveryFailure: string | null;
};

/** Thrown to roll a case's transaction back once it has read its answer. */
class RolledBack extends Error {
  constructor(readonly stored: readonly Stored[]) {
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

/** What the migration leaves of work orders stored like these, in order. */
async function migrated(rows: readonly Stored[]): Promise<readonly Stored[]> {
  try {
    await prisma.$transaction(async (tx) => {
      const issue = await tx.issue.create({
        data: {
          typeId,
          statusId: type.statusIds.DONE,
          outcome: "FIXED",
          priority: "NORMAL",
          location: null,
          description: "",
          closedAt: new Date(),
        },
        select: { id: true },
      });
      const ids: string[] = [];
      for (const row of rows) {
        const order = await tx.workOrder.create({
          data: {
            issueId: issue.id,
            recipientName: `Rormokare ${suffix}`,
            recipientEmailCipher: "kept-as-it-was",
            body: "Spola avloppet.",
            ...row,
          },
          select: { id: true },
        });
        ids.push(order.id);
      }
      await tx.$executeRawUnsafe(MIGRATION);
      const after = await tx.workOrder.findMany({
        where: { id: { in: ids } },
        select: { id: true, deliveryStatus: true, deliveryFailure: true },
      });
      throw new RolledBack(
        ids.map((id) => {
          const found = after.find((order) => order.id === id);
          if (found === undefined) {
            throw new Error("A work order is gone.");
          }
          return {
            deliveryStatus: found.deliveryStatus,
            deliveryFailure: found.deliveryFailure,
          };
        }),
      );
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.stored;
    }
    throw error;
  }
  throw new Error("The transaction committed.");
}

describe("work orders recorded as not sent before the driver could tell", () => {
  it("become unconfirmed, and nothing else changes", async () => {
    const kept: Stored[] = [
      { deliveryStatus: "FAILED", deliveryFailure: "mail-not-configured" },
      { deliveryStatus: "FAILED", deliveryFailure: "sending-interrupted" },
      { deliveryStatus: "FAILED", deliveryFailure: "delivery-unconfirmed" },
      { deliveryStatus: "FAILED", deliveryFailure: "text-erased" },
      { deliveryStatus: "SENT", deliveryFailure: null },
      { deliveryStatus: "PENDING", deliveryFailure: null },
    ];

    const after = await migrated([
      { deliveryStatus: "FAILED", deliveryFailure: "send-failed" },
      ...kept,
    ]);

    expect(after[0]).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "delivery-unconfirmed",
    });
    expect(after.slice(1)).toEqual(kept);
  });
});

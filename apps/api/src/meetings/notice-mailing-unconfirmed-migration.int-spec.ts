import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * The migration that records an old "send-failed" on a news mailing's email
 * copy or on a meeting notice's copy as unconfirmed, run against a real
 * database.
 *
 * The code was written before the mail driver said whether an error came before
 * or after the handover, so a stored "send-failed" may be a copy the server
 * took. The template the suites run against has had the migration applied
 * already, so each case writes the rows as the earlier code left them, runs the
 * migration's SQL again and reads back what it made of them. Every case runs in
 * a transaction that is rolled back.
 */

const env = loadEnvForIntegrationTests();

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "prisma",
    "migrations",
    "20261105180000_notice_mailing_unconfirmed_send_error",
    "migration.sql",
  ),
  "utf8",
);

const suffix = randomUUID().slice(0, 8);

type Stored = {
  status: "PENDING" | "SENT" | "FAILED";
  failureReason: string | null;
};

type StoredRow = Stored & { id: string };

/** Thrown to roll a case's transaction back once it has read its answer. */
class RolledBack extends Error {
  constructor(readonly stored: readonly Stored[]) {
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

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Runs `write`, then the migration, then `read` in one transaction, and returns
 * what `read` found once the transaction is rolled back.
 */
async function rolledBack(
  write: (tx: Tx) => Promise<readonly string[]>,
  read: (tx: Tx, ids: readonly string[]) => Promise<readonly StoredRow[]>,
): Promise<readonly Stored[]> {
  try {
    await prisma.$transaction(async (tx) => {
      const ids = await write(tx);
      await tx.$executeRawUnsafe(MIGRATION);
      const after = await read(tx, ids);
      throw new RolledBack(
        ids.map((id) => {
          const found = after.find((row) => row.id === id);
          if (found === undefined) {
            throw new Error("A row is gone.");
          }
          return { status: found.status, failureReason: found.failureReason };
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

/** What the migration leaves of news ledger rows stored like these, in order. */
async function migratedNewsRows(
  rows: readonly (Stored & { channel: "EMAIL" | "SMS" })[],
): Promise<readonly Stored[]> {
  return rolledBack(
    async (tx) => {
      const news = await tx.news.create({
        data: {
          slug: `tvattstugan-${suffix}`,
          title: "Nya tider i tvättstugan",
          content: {},
          published: true,
        },
        select: { id: true },
      });
      const ids: string[] = [];
      for (const [index, row] of rows.entries()) {
        const delivery = await tx.newsDelivery.create({
          data: {
            newsId: news.id,
            personId: `person-${suffix}-${String(index)}`,
            ...row,
          },
          select: { id: true },
        });
        ids.push(delivery.id);
      }
      return ids;
    },
    (tx, ids) =>
      tx.newsDelivery.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, status: true, failureReason: true },
      }),
  );
}

/** What the migration leaves of notice ledger rows stored like these, in order. */
async function migratedNoticeRows(
  rows: readonly Stored[],
): Promise<readonly Stored[]> {
  return rolledBack(
    async (tx) => {
      const meeting = await tx.meeting.create({
        data: { kind: "ORDINARY", heldOn: new Date("2027-05-20T00:00:00Z") },
        select: { id: true },
      });
      const notice = await tx.meetingNotice.create({
        data: {
          meetingId: meeting.id,
          startsAt: new Date("2027-05-20T16:00:00Z"),
          place: "Föreningslokalen",
          issuedByPersonId: `board-${suffix}`,
        },
        select: { id: true },
      });
      const ids: string[] = [];
      for (const [index, row] of rows.entries()) {
        const delivery = await tx.meetingNoticeDelivery.create({
          data: {
            noticeId: notice.id,
            personId: `person-${suffix}-${String(index)}`,
            ...row,
          },
          select: { id: true },
        });
        ids.push(delivery.id);
      }
      return ids;
    },
    (tx, ids) =>
      tx.meetingNoticeDelivery.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, status: true, failureReason: true },
      }),
  );
}

describe("news mailing copies recorded as not sent before the driver could tell", () => {
  it("become unconfirmed for email, and nothing else changes", async () => {
    const kept = [
      {
        channel: "SMS",
        status: "FAILED",
        failureReason: "send-failed",
      },
      {
        channel: "EMAIL",
        status: "FAILED",
        failureReason: "mail-not-configured",
      },
      {
        channel: "EMAIL",
        status: "FAILED",
        failureReason: "mailing-interrupted",
      },
      {
        channel: "EMAIL",
        status: "FAILED",
        failureReason: "recipient-objected",
      },
      { channel: "EMAIL", status: "SENT", failureReason: null },
      { channel: "EMAIL", status: "PENDING", failureReason: null },
    ] as const;

    const after = await migratedNewsRows([
      { channel: "EMAIL", status: "FAILED", failureReason: "send-failed" },
      ...kept,
    ]);

    expect(after[0]).toEqual({
      status: "FAILED",
      failureReason: "delivery-unconfirmed",
    });
    expect(after.slice(1)).toEqual(
      kept.map(({ status, failureReason }) => ({ status, failureReason })),
    );
  });
});

describe("notice copies recorded as not sent before the driver could tell", () => {
  it("become unconfirmed and stay failed, and nothing else changes", async () => {
    const kept: Stored[] = [
      { status: "FAILED", failureReason: "mail-not-configured" },
      { status: "FAILED", failureReason: "no-email-address" },
      { status: "FAILED", failureReason: "notice-sending-interrupted" },
      { status: "SENT", failureReason: null },
      { status: "PENDING", failureReason: null },
    ];

    const after = await migratedNoticeRows([
      { status: "FAILED", failureReason: "send-failed" },
      ...kept,
    ]);

    expect(after[0]).toEqual({
      status: "FAILED",
      failureReason: "delivery-unconfirmed",
    });
    expect(after.slice(1)).toEqual(kept);
  });
});

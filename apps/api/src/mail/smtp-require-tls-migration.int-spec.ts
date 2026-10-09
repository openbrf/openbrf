import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLoopbackHost } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * The migration that requires STARTTLS of the SMTP settings a board saved
 * before saving required it, run against a real database.
 *
 * The template the suites run against has had it applied already, to a table
 * with no association in it, so each case writes the row as an older version
 * left it, runs the migration's SQL again, and reads back what it made of it.
 * Every case runs in a transaction that is rolled back, so the association is
 * left as the suite found it whatever happens.
 */

const env = loadEnvForIntegrationTests();

/** Read rather than restated, so the SQL tested is the SQL that is deployed. */
const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "prisma",
    "migrations",
    "20261009120000_smtp_require_tls_saved_before",
    "migration.sql",
  ),
  "utf8",
);

/** Thrown to roll a case's transaction back once it has read its answer. */
class RolledBack extends Error {
  constructor(readonly requireTls: boolean) {
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

/** What the migration leaves in smtpRequireTls on a row stored like this. */
async function migrated(stored: {
  smtpHost: string | null;
  smtpSecure: boolean;
  smtpRequireTls: boolean;
}): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.association.upsert({
        where: { id: 1 },
        create: { id: 1, name: "Brf Eksemplet", ...stored },
        update: stored,
      });
      await tx.$executeRawUnsafe(MIGRATION);
      const row = await tx.association.findUniqueOrThrow({
        where: { id: 1 },
        select: { smtpRequireTls: true },
      });
      throw new RolledBack(row.smtpRequireTls);
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.requireTls;
    }
    throw error;
  }
  throw new Error("The transaction committed.");
}

describe("settings saved before TLS was required", () => {
  it("require STARTTLS of a server that is not on this machine", async () => {
    expect(
      await migrated({
        smtpHost: "smtp.example.se",
        smtpSecure: false,
        smtpRequireTls: false,
      }),
    ).toBe(true);
  });

  it("require it under implicit TLS too, as a save does", async () => {
    // Without effect while the connection is TLS from the first byte, and in
    // force if the board later unticks it without the save that would set it.
    expect(
      await migrated({
        smtpHost: "smtp.example.se",
        smtpSecure: true,
        smtpRequireTls: false,
      }),
    ).toBe(true);
  });

  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])(
    "leave a server on loopback (%s) as it was",
    async (host) => {
      expect(
        await migrated({
          smtpHost: host,
          smtpSecure: false,
          smtpRequireTls: false,
        }),
      ).toBe(false);
    },
  );

  it("leave settings with no server as they were", async () => {
    expect(
      await migrated({
        smtpHost: null,
        smtpSecure: false,
        smtpRequireTls: false,
      }),
    ).toBe(false);
  });

  it("leave settings saved since as they were", async () => {
    expect(
      await migrated({
        smtpHost: "smtp.example.se",
        smtpSecure: false,
        smtpRequireTls: true,
      }),
    ).toBe(true);
  });

  it.each([
    "smtp.example.se",
    "localhost",
    "LOCALHOST",
    "localhost.",
    "127.0.0.2",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
  ])("agree with what a save of %s stores", async (host) => {
    // The rule is the save's (SettingsService.updateSmtp), and a host the two
    // read differently would be required STARTTLS by one and not the other.
    expect(
      await migrated({
        smtpHost: host,
        smtpSecure: false,
        smtpRequireTls: false,
      }),
    ).toBe(!isLoopbackHost(host));
  });
});

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { PrismaService } from "./prisma.service";

/**
 * A database whose time zone is not UTC must not move what raw SQL writes into
 * a `timestamp(3)` column.
 *
 * Prisma reads such a column as UTC. A statement that assigns
 * `clock_timestamp()` to one stores the session's local time, so on a server
 * set to Asia/Tokyo an expiry written that way would read nine hours late.
 * The suite sets the worker's database to Asia/Tokyo, which new sessions
 * inherit, and restores it afterwards: the worker's database is its own (see
 * testing/integration-database.ts), so no other suite sees the change.
 */

const env = loadEnvForIntegrationTests();
const TOKYO = "Asia/Tokyo";
const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const SLACK_MS = 60_000;

let owner: PrismaClient;
let service: PrismaService;
let unpinned: PrismaClient;

/** The time zone the session this client holds reports. */
async function sessionZone(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRaw<
    { zone: string }[]
  >`SELECT current_setting('TimeZone') AS zone`;
  return rows[0]?.zone ?? "";
}

/**
 * How far a `timestamp(3)` value written by raw SQL from `clock_timestamp()`
 * reads from the real clock, in milliseconds. One transaction, so the temporary
 * table is on the connection that wrote it.
 */
async function writtenOffsetMs(client: PrismaClient): Promise<number> {
  const stored = await client.$transaction(async (tx) => {
    await tx.$executeRaw`CREATE TEMP TABLE zone_probe (at timestamp(3) NOT NULL) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO zone_probe (at) VALUES (clock_timestamp())`;
    const rows = await tx.$queryRaw<{ at: Date }[]>`SELECT at FROM zone_probe`;
    return rows[0]?.at;
  });
  if (stored === undefined) throw new Error("The probe row was not read back.");
  return stored.getTime() - Date.now();
}

beforeAll(async () => {
  owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  await owner.$executeRawUnsafe(`
    DO $$ BEGIN
      EXECUTE format('ALTER DATABASE %I SET TimeZone TO %L',
                     current_database(), '${TOKYO}');
    END $$`);
  // Both clients connect after the change, so both start in Tokyo's default.
  unpinned = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  service = new PrismaService(env);
  await service.onModuleInit();
});

afterAll(async () => {
  await service?.onModuleDestroy();
  await unpinned?.$disconnect();
  await owner?.$executeRawUnsafe(`
    DO $$ BEGIN
      EXECUTE format('ALTER DATABASE %I RESET TimeZone', current_database());
    END $$`);
  await owner?.$disconnect();
});

describe("the database session time zone", () => {
  it("is the server's own for a connection that does not ask", async () => {
    // What makes the cases below mean anything: without the pin this is the
    // zone the application would have run in.
    expect(await sessionZone(unpinned)).toBe(TOKYO);
    expect(
      Math.abs((await writtenOffsetMs(unpinned)) - TOKYO_OFFSET_MS),
    ).toBeLessThan(SLACK_MS);
  });

  it("is UTC for the application's connection, whatever the server sets", async () => {
    expect(await sessionZone(service)).toBe("UTC");
  });

  it("leaves a timestamp(3) written from clock_timestamp() on the real clock", async () => {
    expect(Math.abs(await writtenOffsetMs(service))).toBeLessThan(SLACK_MS);
  });
});

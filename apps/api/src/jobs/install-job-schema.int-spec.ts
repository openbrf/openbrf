import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * The job schema install, scripts/install-job-schema.mjs, as the migrate
 * service runs it: as the owner, before the application starts.
 *
 * pg-boss, migrating as the owner, turns two kinds of row into SQL of its own:
 * a queue's job table name, which it splices into index statements for every
 * partitioned queue, and a pending index build in pgboss.bam, which it runs as
 * written. The runtime role writes queue rows by design, and could write index
 * builds until the hardening took that away, so the install has to look at
 * both before pg-boss does. The rows here are planted as the suite's owner
 * connection, standing in for whatever the runtime role could have written.
 */

const env = loadEnvForIntegrationTests();

const suffix = process.hrtime.bigint().toString(36);
const QUEUE = `install-probe-${suffix}`;
const BUILD = `install_probe_${suffix}`;
const PROBE_ROLE = `openbrf_bam_probe_${suffix.replace(/[^a-z0-9]/gi, "")}`;
/** What a planted index build would leave behind, had it run. */
const PLANTED_TABLE = `public.install_probe_${suffix.replace(/[^a-z0-9]/gi, "")}`;

let owner: PrismaClient;

/** Runs the install the way the migrate service does, and says how it went. */
function install(): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts", "install-job-schema.mjs")],
    {
      env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The index builds this suite planted, whatever became of them. */
async function plantedBuilds(): Promise<number> {
  const [row] = await owner.$queryRawUnsafe<{ count: number }[]>(
    "SELECT count(*)::int AS count FROM pgboss.bam WHERE name = $1",
    BUILD,
  );
  return row?.count ?? 0;
}

/**
 * Roles other than the owner that can write pgboss.bam, by the install
 * script's own test: a table or column grant of INSERT or UPDATE.
 */
async function foreignWriters(): Promise<string[]> {
  const rows = await owner.$queryRawUnsafe<{ grantee: string }[]>(
    `SELECT DISTINCT pg_get_userbyid(g.grantee) AS grantee
     FROM pg_class c
     CROSS JOIN LATERAL (
       SELECT c.relacl AS acl
       UNION ALL
       SELECT a.attacl FROM pg_attribute a WHERE a.attrelid = c.oid
     ) AS acls
     CROSS JOIN LATERAL aclexplode(acls.acl) AS g
     WHERE c.oid = 'pgboss.bam'::regclass
       AND g.grantee <> c.relowner
       AND g.privilege_type IN ('INSERT', 'UPDATE')`,
  );
  return rows.map((row) => row.grantee);
}

/** A pending index build, which pg-boss's runner would execute verbatim. */
async function plantBuild(command: string): Promise<void> {
  await owner.$executeRawUnsafe(
    `INSERT INTO pgboss.bam (name, version, status, table_name, command)
     VALUES ($1, 0, 'pending', 'job_common', $2)`,
    BUILD,
    command,
  );
}

beforeAll(async () => {
  owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  // The schema the cases below plant rows in, installed as a deploy would.
  const installed = install();
  expect(installed.status, installed.output).toBe(0);
}, 90_000);

afterAll(async () => {
  await owner.$executeRawUnsafe(
    "DELETE FROM pgboss.queue WHERE name = $1",
    QUEUE,
  );
  await owner.$executeRawUnsafe(
    "DELETE FROM pgboss.bam WHERE name = $1",
    BUILD,
  );
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS ${PLANTED_TABLE}`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await owner.$disconnect();
});

describe("the job schema install", () => {
  it.each([
    { what: "a partitioned queue", change: "partition = true" },
    {
      what: "a queue naming a job table of its own",
      change: `table_name = 'job_${suffix}'`,
    },
  ])(
    "stops on $what",
    async ({ change }) => {
      // An ordinary queue first, as a feature module declares one at runtime,
      // then rewritten the way the runtime role could rewrite it.
      await owner.$executeRawUnsafe(
        `SELECT pgboss.create_queue($1, '{"policy": "standard"}'::jsonb)`,
        QUEUE,
      );
      try {
        await owner.$executeRawUnsafe(
          `UPDATE pgboss.queue SET ${change} WHERE name = $1`,
          QUEUE,
        );

        const refused = install();
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain("pgboss.queue holds 1 queue(s)");
      } finally {
        await owner.$executeRawUnsafe(
          "DELETE FROM pgboss.queue WHERE name = $1",
          QUEUE,
        );
      }
    },
    90_000,
  );

  it("removes an index build that had not run while another role could write the queue of them", async () => {
    // What every instance looked like before the hardening revoked the
    // runtime role's writes: a grant on pgboss.bam to a role that is not its
    // owner, so a pending build there may be that role's.
    await owner.$executeRawUnsafe(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
    await owner.$executeRawUnsafe(
      `GRANT INSERT ON pgboss.bam TO ${PROBE_ROLE}`,
    );
    try {
      await plantBuild(`CREATE TABLE ${PLANTED_TABLE} (id integer)`);

      const installed = install();
      expect(installed.status, installed.output).toBe(0);
      expect(await plantedBuilds(), "the build is gone").toBe(0);
      const [planted] = await owner.$queryRawUnsafe<{ present: boolean }[]>(
        `SELECT to_regclass('${PLANTED_TABLE}') IS NOT NULL AS present`,
      );
      expect(planted?.present, "the build never ran").toBe(false);
    } finally {
      await owner.$executeRawUnsafe(
        `REVOKE INSERT ON pgboss.bam FROM ${PROBE_ROLE}`,
      );
      await owner.$executeRawUnsafe(
        "DELETE FROM pgboss.bam WHERE name = $1",
        BUILD,
      );
    }
  }, 90_000);

  it("leaves an index build alone once only the owner can write the queue of them", async () => {
    // The owner's own builds, enqueued by a pg-boss upgrade, are what the
    // queue is for once the hardening has run. The database is shared, so a
    // grant left by another suite would remove the build for a reason this
    // test is not about; it is named here rather than as a missing build.
    expect(
      await foreignWriters(),
      "roles other than the owner that can write pgboss.bam",
    ).toEqual([]);
    await plantBuild("SELECT 1");

    const installed = install();
    expect(installed.status, installed.output).toBe(0);
    expect(await plantedBuilds(), "the build is still there").toBe(1);
  }, 90_000);
});

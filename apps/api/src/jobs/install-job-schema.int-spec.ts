import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { getRollbackPlans, PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client";
import {
  BASE_URL_VARIABLE,
  databaseName,
  maintenanceUrl,
  quoteIdentifier,
  withDatabase,
} from "../testing/integration-database";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { JOB_SCHEMA } from "./job-queue.service";

/**
 * Runs scripts/install-job-schema.mjs against a job schema that already
 * exists, the way a deploy upgrading pg-boss does.
 *
 * A migration that adds an index to an existing job table does not build it:
 * it records one build per job table in pgboss.bam, for pg-boss's background
 * runner. The application runs with migration disabled in production, so the
 * installer is the only process that runs those builds, and a deploy that goes
 * on before they finish leaves the schema without the index. The fresh install
 * the integration template gets queues nothing, so it cannot show any of this.
 *
 * Each test gets a database of its own: the installer always works on the
 * "pgboss" schema, and the worker's database already holds one.
 */

/** The migration whose index builds the tests leave to the installer. */
const UPGRADE_VERSION = 45;
/** The index that migration adds to every job table. */
const INDEX_SUFFIX = "_i13";

/** The package root, where `pnpm test:int` runs. */
const apiDirectory = process.cwd();

const baseUrl = process.env[BASE_URL_VARIABLE] ?? process.env.DATABASE_URL;
const poolId = process.env.VITEST_POOL_ID ?? "1";

const created: string[] = [];

async function withClient<T>(
  url: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** An empty database on the test cluster, dropped again after the test. */
async function scratchDatabase(label: string): Promise<string> {
  if (baseUrl === undefined || baseUrl === "") {
    throw new Error("Integration tests need DATABASE_URL to be set.");
  }
  const name = `${databaseName(baseUrl)}_test_${poolId}_${label}`;
  await withClient(maintenanceUrl(baseUrl), async (client) => {
    await client.query(
      `drop database if exists ${quoteIdentifier(name)} with (force)`,
    );
    await client.query(`create database ${quoteIdentifier(name)}`);
  });
  created.push(name);
  return withDatabase(baseUrl, name);
}

interface InstallerRun {
  code: number | null;
  output: string;
}

/** Runs the installer to its exit, as the deploy does. */
function runInstaller(databaseUrl: string): Promise<InstallerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join("scripts", "install-job-schema.mjs")],
      {
        cwd: apiDirectory,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DATABASE_URL_RUNTIME: undefined,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}

/**
 * A job schema at the version before UPGRADE_VERSION, with a job table that
 * already exists: the shared one every queue writes to. The install refuses a
 * partitioned queue, which would have a job table of its own, so there is only
 * the one. Returns the names of the job tables.
 *
 * The schema is installed current, given its queues and then rolled back,
 * which leaves exactly what a database still on the older pg-boss holds.
 */
async function schemaBeforeUpgrade(
  databaseUrl: string,
  queues: string[],
): Promise<string[]> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: JOB_SCHEMA,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  try {
    for (const name of queues) {
      await boss.createQueue(name);
    }
  } finally {
    await boss.stop({ graceful: false });
  }

  return withClient(databaseUrl, async (client) => {
    await client.query(getRollbackPlans(JOB_SCHEMA, UPGRADE_VERSION));
    const { rows } = await client.query<{ table_name: string }>(
      `select 'job_common' as table_name`,
    );
    return rows.map((row) => row.table_name);
  });
}

async function schemaVersion(client: Client): Promise<number> {
  const { rows } = await client.query<{ version: number }>(
    `select version from ${JOB_SCHEMA}.version`,
  );
  return rows[0]?.version ?? 0;
}

interface BamRow {
  table_name: string;
  status: string;
  error: string | null;
}

async function indexBuilds(client: Client): Promise<BamRow[]> {
  const { rows } = await client.query<BamRow>(
    `select table_name, status, error from ${JOB_SCHEMA}.bam
     where version = $1 order by table_name`,
    [UPGRADE_VERSION],
  );
  return rows;
}

interface IndexState {
  table: string;
  valid: boolean;
  ready: boolean;
}

/** The UPGRADE_VERSION index on each job table, as the catalog has it. */
async function upgradeIndexes(client: Client): Promise<IndexState[]> {
  const { rows } = await client.query<IndexState>(
    `select t.relname as table, x.indisvalid as valid, x.indisready as ready
     from pg_index x
     join pg_class i on i.oid = x.indexrelid
     join pg_class t on t.oid = x.indrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = $1 and i.relname = t.relname || $2
     order by t.relname`,
    [JOB_SCHEMA, INDEX_SUFFIX],
  );
  return rows;
}

/**
 * The upgrade is complete: every build it queued is done, and the index it
 * adds is on every job table, valid and ready for use.
 */
async function expectUpgradeFinished(
  databaseUrl: string,
  tables: string[],
): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    expect(await schemaVersion(client)).toBe(UPGRADE_VERSION);
    expect(await indexBuilds(client)).toEqual(
      tables.map((table) => ({
        table_name: table,
        status: "completed",
        error: null,
      })),
    );
    expect(await upgradeIndexes(client)).toEqual(
      tables.map((table) => ({ table, valid: true, ready: true })),
    );
  });
}

afterEach(async () => {
  if (baseUrl === undefined || baseUrl === "") {
    return;
  }
  await withClient(maintenanceUrl(baseUrl), async (client) => {
    for (const name of created.splice(0)) {
      await client.query(
        `drop database if exists ${quoteIdentifier(name)} with (force)`,
      );
    }
  });
});

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
/** A role holding the runtime role's writes on pgboss.queue. */
const WRITER_ROLE = `openbrf_queue_probe_${suffix.replace(/[^a-z0-9]/gi, "")}`;
const WRITER_PASSWORD = randomBytes(16).toString("hex");
/** The trigger the install puts on pgboss.queue. */
const QUEUE_GUARD = "refuse_own_job_table";
/** PostgreSQL's check_violation, which that trigger raises. */
const CHECK_VIOLATION = "23514";

let owner: PrismaClient;

/** Whether the install's trigger is on pgboss.queue, and switched on. */
async function queueGuarded(): Promise<boolean> {
  const [row] = await owner.$queryRawUnsafe<{ present: boolean }[]>(
    `SELECT EXISTS (
       SELECT FROM pg_trigger
       WHERE tgrelid = 'pgboss.queue'::regclass
         AND tgname = $1 AND tgenabled = 'O'
     ) AS present`,
    QUEUE_GUARD,
  );
  return row?.present === true;
}

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
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${WRITER_ROLE}`);
  await owner.$disconnect();
});

describe("install-job-schema", () => {
  it("installs a fresh schema with no index builds left over", async () => {
    const databaseUrl = await scratchDatabase("job_fresh");

    const run = await runInstaller(databaseUrl);

    expect(run.output).toContain('Job schema "pgboss" is installed');
    expect(run.code).toBe(0);
    await withClient(databaseUrl, async (client) => {
      expect(await schemaVersion(client)).toBe(UPGRADE_VERSION);
      expect(await indexBuilds(client)).toEqual([]);
      expect(await upgradeIndexes(client)).toEqual([
        { table: "job_common", valid: true, ready: true },
      ]);
    });
  }, 60_000);

  it("finishes every index build an upgrade queues before it exits", async () => {
    const databaseUrl = await scratchDatabase("job_upgrade");
    const tables = await schemaBeforeUpgrade(databaseUrl, [
      "install-test-plain",
    ]);
    expect(tables).toEqual(["job_common"]);

    const run = await runInstaller(databaseUrl);

    expect(run.output).toContain('Job schema "pgboss" is installed');
    expect(run.code).toBe(0);
    await expectUpgradeFinished(databaseUrl, tables);
  }, 120_000);

  it("fails on an index build that fails, and finishes it on the next run", async () => {
    const databaseUrl = await scratchDatabase("job_failed_build");
    const tables = await schemaBeforeUpgrade(databaseUrl, [
      "install-test-duplicates",
    ]);

    // Two jobs that the unique index the upgrade adds cannot both satisfy.
    // The migration adds its column only if it is missing, so it can be put in
    // place first; the build on job_common then fails on the duplicate.
    await withClient(databaseUrl, async (client) => {
      await client.query(
        `alter table ${JOB_SCHEMA}.job add column upsert_by_key bool`,
      );
      await client.query(
        `insert into ${JOB_SCHEMA}.job (name, singleton_key, upsert_by_key)
         values ($1, 'apartment-1201', true), ($1, 'apartment-1201', true)`,
        ["install-test-duplicates"],
      );
    });

    const failed = await runInstaller(databaseUrl);

    expect(failed.output).toContain(
      'Job schema "pgboss" was not fully migrated',
    );
    expect(failed.code).not.toBe(0);
    await withClient(databaseUrl, async (client) => {
      const builds = await indexBuilds(client);
      expect(builds.find((build) => build.table_name === "job_common")).toEqual(
        {
          table_name: "job_common",
          status: "failed",
          error: expect.stringContaining("job_common_i13") as unknown,
        },
      );
      expect(
        (await upgradeIndexes(client)).find(
          (index) => index.table === "job_common",
        )?.valid,
      ).not.toBe(true);

      await client.query(`delete from ${JOB_SCHEMA}.job where name = $1`, [
        "install-test-duplicates",
      ]);
    });

    const retried = await runInstaller(databaseUrl);

    expect(retried.output).toContain('Job schema "pgboss" is installed');
    expect(retried.code).toBe(0);
    await expectUpgradeFinished(databaseUrl, tables);
  }, 180_000);
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
      // then rewritten as it could have been before the install's trigger
      // was there: the trigger refuses the owner too, so it is dropped first,
      // and the install puts it back before it looks.
      await owner.$executeRawUnsafe(
        `SELECT pgboss.create_queue($1, '{"policy": "standard"}'::jsonb)`,
        QUEUE,
      );
      try {
        await owner.$executeRawUnsafe(
          `DROP TRIGGER ${QUEUE_GUARD} ON pgboss.queue`,
        );
        await owner.$executeRawUnsafe(
          `UPDATE pgboss.queue SET ${change} WHERE name = $1`,
          QUEUE,
        );

        const refused = install();
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain("pgboss.queue holds 1 queue(s)");
        expect(await queueGuarded(), "the trigger is back").toBe(true);
      } finally {
        await owner.$executeRawUnsafe(
          "DELETE FROM pgboss.queue WHERE name = $1",
          QUEUE,
        );
      }
    },
    90_000,
  );

  it("leaves a role that writes queues unable to make one partitioned or give it a job table of its own", async () => {
    // What harden-runtime-role.sql leaves the application on the queue table:
    // it declares its queues at runtime, so it keeps every write.
    await owner.$executeRawUnsafe(
      `CREATE ROLE ${WRITER_ROLE} LOGIN PASSWORD '${WRITER_PASSWORD}'`,
    );
    await owner.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA pgboss TO ${WRITER_ROLE}`,
    );
    await owner.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.queue TO ${WRITER_ROLE}`,
    );
    await owner.$executeRawUnsafe(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${WRITER_ROLE}`,
    );
    const url = new URL(env.DATABASE_URL);
    url.username = WRITER_ROLE;
    url.password = WRITER_PASSWORD;
    try {
      await withClient(url.href, async (client) => {
        const sqlState = (statement: string, values: unknown[]) =>
          client.query(statement, values).then(
            () => undefined,
            (error: unknown) => (error as { code?: string }).code,
          );

        await client.query(
          `SELECT pgboss.create_queue($1, '{"policy": "standard"}'::jsonb)`,
          [QUEUE],
        );
        expect(
          await sqlState(
            "UPDATE pgboss.queue SET partition = true WHERE name = $1",
            [QUEUE],
          ),
          "made partitioned",
        ).toBe(CHECK_VIOLATION);
        expect(
          await sqlState(
            "UPDATE pgboss.queue SET table_name = $2 WHERE name = $1",
            [QUEUE, `job_${suffix}`],
          ),
          "given a job table of its own",
        ).toBe(CHECK_VIOLATION);
        expect(
          await sqlState(
            `INSERT INTO pgboss.queue (name, policy, retry_limit, retry_delay,
               retry_backoff, expire_seconds, retention_seconds,
               deletion_seconds, partition, table_name)
             VALUES ($1, 'standard', 0, 0, false, 900, 900, 900, true, $2)`,
            [`${QUEUE}-inserted`, `job_${suffix}`],
          ),
          "inserted partitioned",
        ).toBe(CHECK_VIOLATION);

        const { rows } = await client.query<{
          partition: boolean;
          table_name: string;
        }>("SELECT partition, table_name FROM pgboss.queue WHERE name = $1", [
          QUEUE,
        ]);
        expect(rows, "the queue is unchanged").toEqual([
          { partition: false, table_name: "job_common" },
        ]);
      });
    } finally {
      await owner.$executeRawUnsafe(
        "DELETE FROM pgboss.queue WHERE name = $1",
        QUEUE,
      );
      await owner.$executeRawUnsafe(`DROP OWNED BY ${WRITER_ROLE}`);
      await owner.$executeRawUnsafe(`DROP ROLE ${WRITER_ROLE}`);
    }
  }, 90_000);

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

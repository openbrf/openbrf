import { spawn } from "node:child_process";
import { join } from "node:path";

import { Client } from "pg";
import { getRollbackPlans, PgBoss } from "pg-boss";
import { afterEach, describe, expect, it } from "vitest";

import {
  BASE_URL_VARIABLE,
  databaseName,
  maintenanceUrl,
  quoteIdentifier,
  withDatabase,
} from "../testing/integration-database";
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
 * A job schema at the version before UPGRADE_VERSION, with job tables that
 * already exist: the shared one every plain queue writes to, and one per
 * partitioned queue. Returns the names of the job tables.
 *
 * The schema is installed current, given its queues and then rolled back,
 * which leaves exactly what a database still on the older pg-boss holds.
 */
async function schemaBeforeUpgrade(
  databaseUrl: string,
  queues: { plain: string[]; partitioned: string[] },
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
    for (const name of queues.plain) {
      await boss.createQueue(name);
    }
    for (const name of queues.partitioned) {
      await boss.createQueue(name, { partition: true });
    }
  } finally {
    await boss.stop({ graceful: false });
  }

  return withClient(databaseUrl, async (client) => {
    await client.query(getRollbackPlans(JOB_SCHEMA, UPGRADE_VERSION));
    const { rows } = await client.query<{ table_name: string }>(
      `select 'job_common' as table_name
       union all
       select table_name from ${JOB_SCHEMA}.queue where partition
       order by table_name`,
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
    const tables = await schemaBeforeUpgrade(databaseUrl, {
      plain: ["install-test-plain"],
      partitioned: ["install-test-partitioned"],
    });
    expect(tables).toHaveLength(2);

    const run = await runInstaller(databaseUrl);

    expect(run.output).toContain('Job schema "pgboss" is installed');
    expect(run.code).toBe(0);
    await expectUpgradeFinished(databaseUrl, tables);
  }, 120_000);

  it("fails on an index build that fails, and finishes it on the next run", async () => {
    const databaseUrl = await scratchDatabase("job_failed_build");
    const tables = await schemaBeforeUpgrade(databaseUrl, {
      plain: ["install-test-duplicates"],
      partitioned: ["install-test-partitioned"],
    });

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

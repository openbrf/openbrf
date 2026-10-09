/**
 * Installs or migrates the pg-boss job schema.
 *
 * Run at deploy time, as the database owner, before the application starts.
 * The application connects with a non-owner role that holds no CREATE
 * privilege (prisma/sql/harden-runtime-role.sql), so it cannot install this
 * itself and is started with pg-boss migration disabled.
 *
 * Usage:
 *   DATABASE_URL=postgresql://owner:...@host/db node scripts/install-job-schema.mjs
 */
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { setTimeout } from "node:timers/promises";

import { PgBoss } from "pg-boss";

function loadNearestEnvFile(startDirectory = process.cwd()) {
  const { root } = parse(startDirectory);
  let directory = startDirectory;
  for (;;) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    if (directory === root) {
      return;
    }
    directory = dirname(directory);
  }
}

loadNearestEnvFile();

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  console.error(
    "DATABASE_URL is required and must point at the schema owner, not the application role.",
  );
  process.exit(1);
}

const boss = new PgBoss({
  connectionString,
  schema: "pgboss",
  migrate: true,
  // Install the schema only: no workers, no maintenance, no scheduler.
  supervise: false,
  schedule: false,
  // The shortest interval pg-boss allows: the wait below drains one index
  // build per interval.
  bamIntervalSeconds: 10,
});

// A failed index build, like any other pg-boss failure, arrives as an event
// rather than a rejection. The first one is kept and fails the install.
let failure;
boss.on("error", (error) => {
  console.error("pg-boss error during install:", error);
  failure ??= error;
});
boss.on("bam", ({ name, table, status }) => {
  console.log(`Job schema index build ${name} on pgboss.${table}: ${status}`);
});

/**
 * The rows in the job schema that pg-boss, migrating as the owner, turns into
 * SQL of its own, checked before it gets the chance.
 *
 * A queue's table_name is spliced into the index statements pg-boss runs for
 * every partitioned queue, and a row in pgboss.bam is an index build its
 * runner executes verbatim. The runtime role writes queue rows by design, since
 * a feature module declares its queue at runtime, so whatever it could put
 * there would run as the role that can disable the statutory triggers. Open BRF
 * declares no partitioned queue, so a queue that is one, or that names a job
 * table other than the shared one, stops the install.
 *
 * A build that has not run yet is removed while a role other than the owner
 * can write pgboss.bam - every instance until the runtime role's hardening
 * first revoked that - because it cannot then be told from one that role
 * wrote. Once only the owner can, the builds are the owner's and are left.
 */
async function refuseRowsTheOwnerWouldRun(db) {
  const { rows } = await db.executeSql(
    `SELECT to_regclass('pgboss.queue') IS NOT NULL AS queue,
            to_regclass('pgboss.bam') IS NOT NULL AS bam`,
  );
  if (rows[0].queue) {
    const queues = await db.executeSql(
      `SELECT count(*)::int AS count FROM pgboss.queue
       WHERE partition OR table_name IS DISTINCT FROM 'job_common'`,
    );
    const { count } = queues.rows[0];
    if (count > 0) {
      console.error(
        `pgboss.queue holds ${String(count)} queue(s) that are partitioned or ` +
          "name a job table of their own. Open BRF declares none, and pg-boss " +
          "builds SQL from those names when it migrates its schema as the " +
          "owner, so the install stops here. Look at them with SELECT name, " +
          "partition, table_name FROM pgboss.queue WHERE partition OR " +
          "table_name <> 'job_common', delete any you do not recognise, and " +
          "deploy again.",
      );
      process.exit(1);
    }
  }
  if (rows[0].bam) {
    // Table and column grants alike: either lets a role write a row.
    const removed = await db.executeSql(
      `DELETE FROM pgboss.bam
       WHERE status <> 'completed'
         AND EXISTS (
           SELECT 1
           FROM pg_class c
           CROSS JOIN LATERAL (
             SELECT c.relacl AS acl
             UNION ALL
             SELECT a.attacl FROM pg_attribute a WHERE a.attrelid = c.oid
           ) AS acls
           CROSS JOIN LATERAL aclexplode(acls.acl) AS g
           WHERE c.oid = 'pgboss.bam'::regclass
             AND g.grantee <> c.relowner
             AND g.privilege_type IN ('INSERT', 'UPDATE')
         )`,
    );
    if (removed.rowCount > 0) {
      console.log(
        `Removed ${String(removed.rowCount)} index build(s) that had not run ` +
          "from pgboss.bam, which a role other than the schema owner could write.",
      );
    }
  }
}

// Opened here so that the check runs on the pool pg-boss then starts on.
const db = boss.getDb();
await db.open();
await refuseRowsTheOwnerWouldRun(db);

// A migration that adds an index to a job table that already exists does not
// build it: it records the build in pgboss.bam for pg-boss's background runner,
// which only an instance started with migration enabled runs. In production
// the application is not, so the builds have to finish here, before the deploy
// goes on.
async function finishIndexBuilds() {
  let reported;
  for (;;) {
    if (failure !== undefined) {
      throw failure;
    }
    const unfinished = (await boss.getBamEntries()).filter(
      (entry) => entry.status !== "completed",
    );
    if (unfinished.length === 0) {
      return;
    }
    if (unfinished.length !== reported) {
      reported = unfinished.length;
      console.log(
        `Waiting for ${reported} job schema index build(s) to finish.`,
      );
    }
    await setTimeout(1000);
  }
}

await boss.start();
try {
  await finishIndexBuilds();
  console.log('Job schema "pgboss" is installed and up to date.');
} catch (error) {
  // An error event was already printed by its handler above.
  if (error !== failure) {
    console.error(error);
  }
  console.error(
    'Job schema "pgboss" was not fully migrated. A failed index build keeps its error in pgboss.bam.',
  );
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false });
}

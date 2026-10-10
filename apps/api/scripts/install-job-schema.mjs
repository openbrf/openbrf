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
 * Makes pgboss.queue refuse, for every role, a row that is partitioned or names
 * a job table other than the shared one - the rows the check below stops the
 * install for.
 *
 * Owned by the role that runs this, so the runtime role cannot drop or disable
 * it: both need ownership of the table. Creating it takes a lock that waits
 * for every transaction already writing the table, so a row written before
 * the trigger is committed by the time the check reads it. Run before the
 * check, so no row can get past the check afterwards, and again after pg-boss
 * has started, which creates the table on a fresh install. Replacing it leaves
 * nothing to clean up, and does nothing while the table does not exist.
 */
async function guardQueueTable(db) {
  const { rows } = await db.executeSql(
    "SELECT to_regclass('pgboss.queue') IS NOT NULL AS queue",
  );
  if (!rows[0].queue) {
    return;
  }
  await db.executeSql(
    `CREATE OR REPLACE FUNCTION pgboss.refuse_own_job_table() RETURNS trigger
     LANGUAGE plpgsql
     SET search_path = pg_catalog, pg_temp
     AS $body$
     BEGIN
       IF NEW.partition IS DISTINCT FROM false
          OR NEW.table_name IS DISTINCT FROM 'job_common' THEN
         RAISE EXCEPTION USING
           ERRCODE = 'check_violation',
           MESSAGE = format(
             'Queue %L cannot be partitioned or name a job table of its own: pg-boss builds SQL from that name as the schema owner.',
             NEW.name);
       END IF;
       RETURN NEW;
     END
     $body$;
     CREATE OR REPLACE TRIGGER refuse_own_job_table
       BEFORE INSERT OR UPDATE ON pgboss.queue
       FOR EACH ROW EXECUTE FUNCTION pgboss.refuse_own_job_table();`,
  );
}

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
 *
 * The check alone would not be a lock: a role that can write pgboss.queue
 * could change a row between it and the migration pg-boss runs next. So the
 * trigger from guardQueueTable goes in first, and a row that would fail the
 * check can no longer be written once the check has looked.
 */
async function refuseRowsTheOwnerWouldRun(db) {
  const { rows } = await db.executeSql(
    `SELECT to_regclass('pgboss.queue') IS NOT NULL AS queue,
            to_regclass('pgboss.bam') IS NOT NULL AS bam`,
  );
  if (rows[0].queue) {
    await guardQueueTable(db);
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

/**
 * Stops the install while a role other than a table's owner, or PUBLIC, holds
 * TRIGGER on a table in the job schema or the application's.
 *
 * CREATE OR REPLACE TRIGGER asks for that privilege and not for ownership. A
 * role holding it could replace the trigger guardQueueTable puts on
 * pgboss.queue with one that does nothing, at any time after this install,
 * and the triggers that keep the statutory archive append-only in the same
 * way. The runtime role's hardening never grants it and revokes it, so a
 * grant found here was made by hand or by another tool. The install refuses
 * rather than revoking it, because whoever held it may have replaced a trigger
 * already, and only a person can tell. Run first, before guardQueueTable
 * relies on the trigger it creates, and again once pg-boss has started: a
 * table it creates then, every table on a fresh install, takes its grants from
 * the owner's default privileges, which the first run cannot see.
 */
async function refuseForeignTriggerGrants(db) {
  const { rows } = await db.executeSql(
    `SELECT CASE WHEN g.grantee = 0 THEN 'PUBLIC'
                 ELSE quote_ident(pg_get_userbyid(g.grantee)) END AS grantee,
            string_agg(format('%I.%I', n.nspname, c.relname), ', '
                       ORDER BY n.nspname, c.relname) AS tables
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) AS g
     WHERE n.nspname IN ('public', 'pgboss')
       AND g.grantee <> c.relowner
       AND g.privilege_type = 'TRIGGER'
     GROUP BY g.grantee
     ORDER BY 1`,
  );
  if (rows.length === 0) {
    return;
  }
  for (const { grantee, tables } of rows) {
    console.error(`${grantee} holds TRIGGER on ${tables}.`);
  }
  console.error(
    "A role holding TRIGGER can replace a trigger on a table it does not " +
      "own: the guards on the statutory archive and on pgboss.queue among " +
      "them. So the install stops here. Check that the triggers on those " +
      "tables are still the ones the migrations and this install created, " +
      "then, as the role that granted it, REVOKE TRIGGER ON ALL TABLES IN " +
      "SCHEMA public, pgboss FROM each role named above, and deploy again. " +
      "A grant that came from default privileges (\\ddp in psql) has to be " +
      "revoked there too, with ALTER DEFAULT PRIVILEGES, or the next table " +
      "created in those schemas gets it again.",
  );
  process.exit(1);
}

// Opened here so that the checks run on the pool pg-boss then starts on.
const db = boss.getDb();
await db.open();
await refuseForeignTriggerGrants(db);
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
  await refuseForeignTriggerGrants(db);
  await guardQueueTable(db);
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

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

import en from "@openbrf/i18n/locales/en.json" with { type: "json" };
import sv from "@openbrf/i18n/locales/sv.json" with { type: "json" };
import { createInstance } from "i18next";
import { PgBoss } from "pg-boss";

import { refuseUnsafeTriggers } from "./check-triggers.mjs";

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

// Output is in the fallback locale, as the application's own command line is.
const i18n = createInstance();
await i18n.init({
  resources: { en: { translation: en }, sv: { translation: sv } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const boss = new PgBoss({
  connectionString,
  // Every connection looks for a name in the built-in catalog only, and in
  // its own temporary schema last. The owner's default search_path starts
  // with "$user" and public, where a function that matched the arguments of
  // one pg-boss calls better than the built-in would run as the owner.
  // pg-boss names its own tables and functions with their schema, and a
  // setting given at connection outranks the role's and the database's.
  options: "-c search_path=pg_catalog,pg_temp",
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
 * How long the install waits, once it stops, for an index build its runner
 * is still running. A build that fails does not end the runner's pass: it
 * goes on to the next pending build at once, so when the install stops on the
 * failure another build may be under way. Stopped without a wait, pg-boss
 * leaves that build running on the server and its row in progress, and runs no
 * other build until the row is five minutes old: the next install waits at
 * least that long before it builds anything. The build is waited for instead,
 * as the install waits for every build that succeeds; only one that outlasts
 * this is left to that recovery.
 */
const RUNNING_BUILD_WAIT_MS = 10 * 60_000;

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

// Opened here so that the checks run on the pool pg-boss then starts on.
//
// The triggers on the job schema's tables and the application's, and who can
// replace them, are checked first (scripts/check-triggers.mjs). The deploy
// checks them before the migrations as well; this covers an install run on its
// own, and comes before guardQueueTable puts back the trigger on pgboss.queue,
// which would hide one that had been replaced. They are checked again once
// pg-boss has started, on the tables it has created by then.
const db = boss.getDb();
await db.open();
await refuseUnsafeTriggers(db, "the install");
await refuseRowsTheOwnerWouldRun(db);

// A migration that adds an index to a job table that already exists does not
// build it: it records the build in pgboss.bam for pg-boss's background runner,
// which only an instance started with migration enabled runs. In production
// the application is not, so the builds have to finish here, before the deploy
// goes on.
//
// A build that has been in progress since before this install started was
// taken up by another install, or by one that stopped while it ran, and pg-boss
// runs nothing else until it finishes or goes stale. That wait is said once per
// build, so an install held up by it does not look as if it hangs. Both times
// are the server's, so the clocks of the two installs do not come into it.
async function finishIndexBuilds(installStarted) {
  let reported;
  const explained = new Set();
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
    for (const entry of unfinished) {
      if (
        entry.status === "in_progress" &&
        entry.startedOn < installStarted &&
        !explained.has(entry.id)
      ) {
        explained.add(entry.id);
        console.log(
          t("jobSchema.install.buildStartedBeforeInstall", {
            name: entry.name,
            table: `pgboss.${entry.table}`,
            startedOn: entry.startedOn.toISOString(),
          }),
        );
      }
    }
    await setTimeout(1000);
  }
}

const { rows: started } = await db.executeSql("SELECT now() AS now");
await boss.start();
try {
  await refuseUnsafeTriggers(db, "the install");
  await guardQueueTable(db);
  await finishIndexBuilds(started[0].now);
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
  await boss.stop({ graceful: true, timeout: RUNNING_BUILD_WAIT_MS });
}

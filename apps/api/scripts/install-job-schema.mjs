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

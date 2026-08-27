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
});

boss.on("error", (error) => {
  console.error("pg-boss error during install:", error);
});

await boss.start();
await boss.stop({ graceful: false });
console.log('Job schema "pgboss" is installed and up to date.');

// Creates the application's database role and constrains it, as the owner.
//
// Two roles, because a table owner can ALTER TABLE ... DISABLE TRIGGER and walk
// straight past the append-only guards on the member register and the audit
// log. prisma/sql/harden-runtime-role.sql creates the runtime role - named by
// RUNTIME_DB_ROLE, openbrf_app unless it is set - and takes those privileges
// away from it; this runs that script on every start, so the constraints are
// reapplied after any migration that added a table.
//
// Run under docker/with-owner-url.mjs, which puts the owner's connection in
// this process's environment.
//
// Neither password reaches psql's arguments. An argument is in
// /proc/<pid>/cmdline, which every process in the container can read; an
// environment is not. The owner's password is split out of DATABASE_URL by
// docker/psql.mjs and travels in PGPASSWORD, the argument carries the rest of
// the URL, and the runtime role's password is read by the SQL itself with
// \getenv from RUNTIME_DB_PASSWORD. Nothing is printed either way. The role's
// name travels the same way, in RUNTIME_DB_ROLE, checked here and passed on
// with the default already applied, so the script and this process cannot
// disagree about it.
//
// The role's connection limit is worked out here too, in
// RUNTIME_DB_CONNECTION_LIMIT: the application's pool, the job queue's and a
// few to spare, so that on a shared server one instance cannot take every
// connection the server has.
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { checkRuntimeServer, fail, runtimeRole } from "./database-url.mjs";
import { ownerConnection } from "./psql.mjs";

/** Relative to the working directory the image sets, /app/apps/api. */
const HARDENING_SQL = "prisma/sql/harden-runtime-role.sql";

/** OPENBRF_DATABASE_POOL_SIZE's default and bounds, as src/config/env.ts has them. */
const DEFAULT_POOL_SIZE = 10;
const MAX_POOL_SIZE = 50;

/** JOB_POOL_SIZE in src/jobs/job-queue.service.ts. */
const JOB_POOL_SIZE = 2;

/**
 * Room for a session nobody pooled: an operator's psql as the runtime role, or
 * a pool still closing while the next opens.
 */
const SPARE_CONNECTIONS = 3;

// A URL that cannot be split stops the boot in ownerConnection(), before psql
// is reached at all: handing it over whole is what would put the owner's
// password into that argument. Prisma rejects the same shape, so nothing that
// could have migrated is being turned away.
const { applyFile } = ownerConnection();

let role;
try {
  role = runtimeRole();
  checkRuntimeServer();
} catch (error) {
  fail(error);
}

// The application refuses a pool size outside these bounds when it starts, so
// a value the script would cap it by is refused here first, with the same
// reason, rather than written into the role.
const configuredPool = process.env.OPENBRF_DATABASE_POOL_SIZE;
const poolSize =
  configuredPool === undefined || configuredPool === ""
    ? DEFAULT_POOL_SIZE
    : Number(configuredPool);
if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > MAX_POOL_SIZE) {
  fail(
    `OPENBRF_DATABASE_POOL_SIZE has to be a whole number from 1 to ${MAX_POOL_SIZE}.`,
  );
}
const connectionLimit = String(poolSize + JOB_POOL_SIZE + SPARE_CONNECTIONS);

applyFile(HARDENING_SQL, {
  RUNTIME_DB_ROLE: role,
  RUNTIME_DB_CONNECTION_LIMIT: connectionLimit,
});

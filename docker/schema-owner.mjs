// Creates the schema owner and gives it the database, as the superuser.
//
// The schema-owner service in docker-compose.prod.yml runs this on every `up`,
// before the migrate service, and then exits. It is the one container besides
// the database that holds the superuser's password, and all it runs with it is
// docker/schema-owner.sql: everything after this, migrations included, runs as
// the owner, which is not a superuser.
//
// The connection is given to psql in libpq's own variables - PGHOST, PGPORT,
// PGDATABASE, PGUSER and PGPASSWORD - rather than as a URL in an argument. An
// argument is in /proc/<pid>/cmdline, which every process in the container can
// read; an environment is not. The owner's password is read by the SQL itself
// with \getenv from OWNER_DB_PASSWORD, and the two role names travel the same
// way, checked here and passed on with their defaults already applied, so the
// script and this process cannot disagree about them.
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { execFileSync } from "node:child_process";

import { ownerRole, runtimeRole } from "./database-url.mjs";

const SCHEMA_OWNER_SQL = "/app/docker/schema-owner.sql";

function fail(message) {
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

const superuserPassword = process.env.POSTGRES_PASSWORD ?? "";
if (superuserPassword === "") {
  fail(
    "POSTGRES_PASSWORD is not set in the schema-owner container. It is the " +
      "database superuser's, which creates the schema owner. Set it in the env " +
      "file and run `up -d` again. An instance on a database server it does " +
      "not administer does not run this service: that server's administrator " +
      'creates the owner (docs/deployment.md, "Several instances on one ' +
      'database server").',
  );
}

let owner;
let runtime;
try {
  owner = ownerRole();
  runtime = runtimeRole();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const psqlEnvironment = {
  ...process.env,
  PGHOST: process.env.POSTGRES_HOST || "db",
  PGPORT: process.env.POSTGRES_PORT || "5432",
  PGDATABASE: process.env.POSTGRES_DB || "openbrf",
  PGUSER: process.env.POSTGRES_USER || "openbrf",
  PGPASSWORD: superuserPassword,
  OWNER_DB_USER: owner,
  RUNTIME_DB_ROLE: runtime,
};

try {
  execFileSync(
    "psql",
    [
      "--quiet",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=on",
      "--file",
      SCHEMA_OWNER_SQL,
    ],
    { stdio: ["ignore", "inherit", "inherit"], env: psqlEnvironment },
  );
} catch {
  // psql has already said why on stderr. Node's own error would add the
  // command line, which holds nothing secret here, but says nothing either.
  fail(`psql could not apply ${SCHEMA_OWNER_SQL} as the database superuser.`);
}

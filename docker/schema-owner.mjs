// Creates the schema owner and gives it the database, as the superuser.
//
// The schema-owner service in docker-compose.prod.yml runs this on every `up`,
// before the migrate service, and then exits. It is the one container besides
// the database that holds the superuser's password, and all it runs with it is
// docker/schema-owner.sql: everything after this, migrations included, runs as
// the owner, which is not a superuser.
//
// The connection is given to psql in libpq's own variables - PGHOST, PGPORT,
// PGDATABASE, PGUSER and PGPASSWORD - rather than as a URL in an argument
// (docker/psql.mjs). An argument is in /proc/<pid>/cmdline, which every
// process in the container can read; an environment is not. The owner's
// password is read by the SQL itself with \getenv from OWNER_DB_PASSWORD, and
// the two role names travel the same way, checked here and passed on with
// their defaults already applied, so the script and this process cannot
// disagree about them.
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { ownerRole, runtimeRole } from "./database-url.mjs";
import { fail, superuserConnection } from "./psql.mjs";

const SCHEMA_OWNER_SQL = "/app/docker/schema-owner.sql";

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

// The first container of a deploy to connect, so the one that waits for the
// database: on a first start the database image initialises the volume with a
// server of its own that is not reachable over the network yet.
const { waitForDatabase, applyFile } = superuserConnection(superuserPassword);
waitForDatabase();
applyFile(SCHEMA_OWNER_SQL, {
  OWNER_DB_USER: owner,
  RUNTIME_DB_ROLE: runtime,
});

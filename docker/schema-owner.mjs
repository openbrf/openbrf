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
// password is read by the SQL itself with \getenv from OWNER_DB_PASSWORD - as
// its SCRAM verifier, so that the password never reaches the server
// (docker/scram.mjs) - and the two role names travel the same way, checked
// here and passed on with their defaults already applied, so the script and
// this process cannot disagree about them.
//
// Neither password has to be supplied. The superuser's is POSTGRES_PASSWORD,
// or the one the superuser-password service put on the volume this service
// mounts read-only. The owner's is OWNER_DB_PASSWORD, or one generated onto
// the owner's volume on any `up` that finds none there, a first boot or a
// later one: this service sets the owner's password on every `up`, so a new
// one replaces nothing that the migrate service, which reads it from the same
// volume after this, could still be using. Unlike the superuser's, there is
// no first-boot rule for it (docker/credentials.mjs says why).
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { ensurePassword } from "./credentials.mjs";
import {
  fail,
  ownerRole,
  PASSWORD_FILES,
  runtimeRole,
  suppliedPassword,
} from "./database-url.mjs";
import { superuserConnection } from "./psql.mjs";
import { rolePassword } from "./scram.mjs";

const SCHEMA_OWNER_SQL = "/app/docker/schema-owner.sql";

const superuserPassword = suppliedPassword(
  "POSTGRES_PASSWORD",
  PASSWORD_FILES.superuser,
);
if (superuserPassword === "") {
  fail(
    "POSTGRES_PASSWORD is not set in the schema-owner container, and there " +
      `is no superuser's password at ${PASSWORD_FILES.superuser}, where the ` +
      "superuser-password service puts it before the database starts. It is " +
      "the database superuser's, which creates the schema owner: run `up -d`, " +
      "which runs that service first. An instance on a database server it " +
      "does not administer does not run this service. For a new instance, the " +
      "server's administrator creates the owner (docs/deployment.md, " +
      '"Several instances on one database server"). An existing instance ' +
      'keeps its owner and follows "An instance on a shared database server".',
  );
}

const ownerPassword =
  process.env.OWNER_DB_PASSWORD || ensurePassword(PASSWORD_FILES.owner);

let owner;
let runtime;
try {
  owner = ownerRole();
  runtime = runtimeRole();
} catch (error) {
  fail(error);
}

// The first container of a deploy to connect, so the one that waits for the
// database: on a first start the database image initialises the volume with a
// server of its own that is not reachable over the network yet.
const { waitForDatabase, applyFile } = superuserConnection(superuserPassword);
waitForDatabase();
applyFile(SCHEMA_OWNER_SQL, {
  OWNER_DB_USER: owner,
  OWNER_DB_PASSWORD: rolePassword(ownerPassword),
  RUNTIME_DB_ROLE: runtime,
});

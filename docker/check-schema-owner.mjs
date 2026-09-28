// Refuses to run the deploy steps as a superuser.
//
// Migrations need to own the tables they change and nothing more. A superuser
// can also run programs on the database host and read its files, so the role
// that applies migrations on every deploy is openbrf_owner, which is not one
// (docker/db/initdb/10-schema-owner.sql). This is where a deploy that still
// connects as the superuser - an instance installed before openbrf_owner
// existed, or a DATABASE_URL pointed at one - is stopped and told what to do,
// rather than carrying on with more privilege than it needs.
//
// Run under docker/with-owner-url.mjs, which puts the owner's connection in
// this process's environment. Also the step that waits for the database, so
// the steps after it can assume one is there.
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { ownerConnection } from "./psql.mjs";

function fail(message) {
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

const { query, waitForDatabase } = ownerConnection();

waitForDatabase();

let superuser;
try {
  superuser = query(
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (superuser === "t") {
  fail(
    "the deploy steps are connecting to the database as a superuser. They " +
      "need to own the schema and nothing more, so they run as openbrf_owner. " +
      "An instance installed before that role existed creates it once, as " +
      'docs/deployment.md describes under "Upgrading to a separate schema ' +
      'owner"; an operator supplying DATABASE_URL points it at a role that ' +
      "owns the database and is not a superuser.",
  );
}

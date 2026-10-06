// Refuses to run the deploy steps as a superuser.
//
// Migrations need to own the tables they change and nothing more. A superuser
// can also run programs on the database host and read its files, so the role
// that applies migrations on every deploy is the schema owner, which is not one
// (docker/schema-owner.sql). This is where a deploy that connects as a
// superuser - a DATABASE_URL pointed at one - is stopped and told what to do,
// rather than carrying on with more privilege than it needs.
//
// Run under docker/with-owner-url.mjs, which puts the owner's connection in
// this process's environment. Also the step that waits for the database, so
// the steps after it can assume one is there.
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { fail } from "./database-url.mjs";
import { ownerConnection } from "./psql.mjs";

const { query, waitForDatabase } = ownerConnection();

waitForDatabase();

let superuser;
try {
  superuser = query(
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
  );
} catch (error) {
  fail(error);
}

if (superuser === "t") {
  fail(
    "the deploy steps are connecting to the database as a superuser. They " +
      "need to own the schema and nothing more, so they run as the schema " +
      "owner, which the schema-owner service creates. An operator supplying " +
      "DATABASE_URL points it at a role that owns the database and is not a " +
      "superuser.",
  );
}

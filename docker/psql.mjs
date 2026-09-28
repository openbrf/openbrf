// One-statement psql queries against the owner's connection, for the deploy
// steps that ask the database a question before they act.
//
// The password does not travel in psql's arguments. An argument is in
// /proc/<pid>/cmdline, which every process in the container can read; the
// environment is not, so PGPASSWORD carries it and the argument carries the
// rest of the URL. A URL that cannot be split is refused by
// database-url.mjs before psql is reached at all.
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { execFileSync } from "node:child_process";

import { passwordOf, withoutPassword } from "./database-url.mjs";

const CONNECT_ATTEMPTS = 30;
const CONNECT_DELAY_MS = 1000;

/**
 * What psql writes when the server answered and turned the login away. Only
 * ever matched against, never printed: see query() for why nothing psql says
 * reaches the log.
 */
const LOGIN_REFUSED =
  /password authentication failed|role "[^"]*" does not exist|no password supplied/;

export class LoginRefusedError extends Error {}

function fail(message) {
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

/**
 * A connection to the database DATABASE_URL names, for queries that return
 * one value. Stops the process with a message if the URL cannot be split.
 */
export function ownerConnection() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail(
      "DATABASE_URL is not set. This runs under with-owner-url.mjs, which is what sets it.",
    );
  }

  let argument;
  let password;
  try {
    argument = withoutPassword(connectionString, "DATABASE_URL");
    password = passwordOf(connectionString, "DATABASE_URL");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const environment =
    password === "" ? process.env : { ...process.env, PGPASSWORD: password };

  /**
   * Runs one query and returns the single value it selects, trimmed.
   *
   * A failure is replaced rather than passed on. Node puts the whole command
   * line into the message of the error it throws, and libpq echoes the string
   * it could not parse, so anything derived from the connection would reach
   * whatever reads the error - and this runs during startup, so that is the
   * container's log, which is shipped off the host, readable by anyone with
   * Docker access and the first thing pasted into a bug report. Not even the
   * host is reported, because a password containing a delimiter moves the
   * boundaries of every other component in the URL it sits in.
   */
  function query(sql) {
    try {
      return execFileSync(
        "psql",
        [
          "--quiet",
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--set",
          "ON_ERROR_STOP=on",
          argument,
          "--command",
          sql,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: environment,
        },
      ).trim();
    } catch (failure) {
      if (LOGIN_REFUSED.test(String(failure?.stderr ?? ""))) {
        throw new LoginRefusedError(
          "the database refused the owner connection's role or password",
        );
      }
      throw new Error("psql could not run a statement against DATABASE_URL");
    }
  }

  /**
   * Waits for the database to accept connections. Compose already gates the
   * deploy on the database's health check, but a database that restarts
   * underneath it should not turn into a failed deploy.
   *
   * A login the server turned away is not waited out: it will be turned away
   * thirty times over, and the reason is almost always an instance installed
   * before the schema owner existed, which has one fix.
   */
  function waitForDatabase() {
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        query("SELECT 1");
        return;
      } catch (error) {
        if (error instanceof LoginRefusedError) {
          fail(
            "the database refused the schema owner's login. An instance " +
              "installed before openbrf_owner existed creates that role once, " +
              'as docs/deployment.md describes under "Upgrading to a separate ' +
              'schema owner". Otherwise, check that OWNER_DB_PASSWORD is the ' +
              "password the database was given, or that DATABASE_URL names " +
              "the right role.",
          );
        }
        if (attempt === CONNECT_ATTEMPTS) {
          fail(
            `the database did not accept a connection within ${CONNECT_ATTEMPTS} seconds. ` +
              "Check that it is running, and that DATABASE_URL names the right host, port, " +
              "database and role.",
          );
        }
        // A busy wait is acceptable here: this runs once, before the server.
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          CONNECT_DELAY_MS,
        );
      }
    }
  }

  return { query, waitForDatabase };
}

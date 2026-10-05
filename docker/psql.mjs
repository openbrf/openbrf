// psql against the owner's connection or the superuser's, for the deploy steps:
// one-statement queries for the steps that ask the database a question before
// they act, a wait for the database to accept connections, and the SQL files
// that do the work.
//
// The password does not travel in psql's arguments. An argument is in
// /proc/<pid>/cmdline, which every process in the container can read; the
// environment is not, so PGPASSWORD carries it. The owner's connection is a URL
// whose password is split out here and whose argument carries the rest; a URL
// that cannot be split is refused by database-url.mjs before psql is reached at
// all. The superuser's goes entirely in libpq's own variables.
//
// Node built-ins and psql only, like the rest of docker/, so this stays
// readable and runnable inside the image an operator is debugging.

import { execFileSync } from "node:child_process";

import {
  databaseServer,
  fail,
  passwordOf,
  withoutPassword,
} from "./database-url.mjs";

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

/**
 * A connection to the database DATABASE_URL names, as the schema owner. Stops
 * the process with a message if the URL cannot be split.
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
    fail(error);
  }

  return connection({
    arguments: [argument],
    environment:
      password === "" ? process.env : { ...process.env, PGPASSWORD: password },
    described: "against DATABASE_URL",
    loginRefused:
      "the database refused the schema owner's login. The schema-owner " +
      "service creates that role and sets its password from " +
      "OWNER_DB_PASSWORD on every `up`, before this runs: check that it " +
      "ran and succeeded. On a database server you do not administer, " +
      "check that OWNER_DB_USER and OWNER_DB_PASSWORD are the role and " +
      "password its administrator created, or that DATABASE_URL names " +
      "the right role.",
    unreachable:
      "Check that it is running, and that DATABASE_URL names the right host, " +
      "port, database and role.",
  });
}

/**
 * A connection to the bundled database as its superuser, from POSTGRES_USER and
 * POSTGRES_PASSWORD, for the schema-owner service and nothing else.
 *
 * The session's search_path is pinned to the built-in catalog. The database
 * belongs to the schema owner, which can give it a search_path of its own and
 * put functions and operators in public; a connection option outranks the
 * database's setting, so a superuser session never looks there.
 */
export function superuserConnection(password) {
  const { host, port, database } = databaseServer();
  return connection({
    arguments: [],
    environment: {
      ...process.env,
      PGHOST: host,
      PGPORT: port,
      PGDATABASE: database,
      PGUSER: process.env.POSTGRES_USER || "openbrf",
      PGPASSWORD: password,
      PGOPTIONS: "-c search_path=pg_catalog,pg_temp",
    },
    described: "as the database superuser",
    loginRefused:
      "the database refused the superuser's login. POSTGRES_PASSWORD has to " +
      "be the password the database's volume was first initialised with: " +
      "the database image reads it only once, when it creates the volume.",
    unreachable:
      "Check that the db service is running, and that POSTGRES_HOST, " +
      "POSTGRES_PORT and POSTGRES_DB name it.",
  });
}

function connection({
  arguments: connectionArguments,
  environment,
  described,
  loginRefused,
  unreachable,
}) {
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
          ...connectionArguments,
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
          "the database refused the connection's role or password",
        );
      }
      throw new Error(`psql could not run a statement ${described}`);
    }
  }

  /**
   * Waits for the database to accept connections. Compose already gates the
   * deploy on the database's health check, but a database that restarts
   * underneath it should not turn into a failed deploy, and on a first start
   * the database image runs a server of its own for a moment, which answers
   * on its socket but not over the network.
   *
   * A login the server turned away is not waited out: it will be turned away
   * thirty times over, and waiting changes nothing about a missing role or a
   * wrong password.
   */
  function waitForDatabase() {
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        query("SELECT 1");
        return;
      } catch (error) {
        if (error instanceof LoginRefusedError) {
          fail(loginRefused);
        }
        if (attempt === CONNECT_ATTEMPTS) {
          fail(
            `the database did not accept a connection within ${CONNECT_ATTEMPTS} seconds. ${unreachable}`,
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

  /**
   * Applies one SQL file in a single psql run, with these variables added to
   * its environment for the file to read with \getenv. What psql says goes to
   * the log as it is: the files print nothing secret, and their refusals are
   * what an operator needs to read.
   */
  function applyFile(file, variables = {}) {
    try {
      execFileSync(
        "psql",
        [
          "--quiet",
          "--no-psqlrc",
          "--set",
          "ON_ERROR_STOP=on",
          ...connectionArguments,
          "--file",
          file,
        ],
        {
          stdio: ["ignore", "inherit", "inherit"],
          env: { ...environment, ...variables },
        },
      );
    } catch {
      // psql has already said why on stderr. Node's own error would add the
      // command line, which carries the connection.
      fail(`psql could not apply ${file} ${described}.`);
    }
  }

  return { query, waitForDatabase, applyFile };
}

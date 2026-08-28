// Provisions the field encryption key on a genuine first boot, and refuses to
// provision one on any other boot.
//
// The application will not generate a key in production (ADR 0004): a fresh key
// on an instance that already holds ciphertext would make every encrypted field
// permanently unreadable, and the commonest cause of a missing key file is a
// data volume that was not mounted. Only the entrypoint can tell those two
// cases apart, because only it looks at the database before the application
// connects: a database with no applied migrations is a first boot, and one with
// applied migrations holds data the missing key belongs to.
//
// Node built-ins and psql only, no imports from the workspace, so this stays
// readable and runnable inside the image an operator is debugging.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { passwordOf, withoutPassword } from "./database-url.mjs";

const KEY_LENGTH_BYTES = 32;
/** Must match EncryptionKeyProvider in the API. */
const KEY_FILE_NAME = "field-encryption.key";

const CONNECT_ATTEMPTS = 30;
const CONNECT_DELAY_MS = 1000;

function log(message) {
  console.log(`openbrf: ${message}`);
}

function fail(message) {
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

const dataDir = process.env.OPENBRF_DATA_DIR ?? "/data";
const keyPath = resolve(join(dataDir, "keys", KEY_FILE_NAME));

if (process.env.OPENBRF_ENCRYPTION_KEY) {
  log("using the field encryption key from OPENBRF_ENCRYPTION_KEY");
  process.exit(0);
}

if (existsSync(keyPath)) {
  log(`field encryption key found at ${keyPath}`);
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  fail(
    "DATABASE_URL is not set, so a first boot cannot be told apart from a missing data volume.",
  );
}

// The password does not travel in psql's arguments. An argument is in
// /proc/<pid>/cmdline, which every process in the container can read; the
// environment is not, so PGPASSWORD carries it and the argument carries the
// rest of the URL.
const connectionArgument = withoutPassword(connectionString);
const connectionPassword = passwordOf(connectionString);
const psqlEnvironment =
  connectionPassword === ""
    ? process.env
    : { ...process.env, PGPASSWORD: connectionPassword };

/**
 * Runs one query and returns the single value it selects, trimmed.
 *
 * A failure is replaced rather than passed on. Node puts the whole command line
 * into the message of the error it throws, and libpq echoes the string it could
 * not parse, so anything derived from the connection would reach whatever reads
 * the error - and this runs during startup, so that is the container's log,
 * which is shipped off the host, readable by anyone with Docker access and the
 * first thing pasted into a bug report. Not even the host is reported, because
 * a password containing a delimiter moves the boundaries of every other
 * component in the URL it sits in.
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
        connectionArgument,
        "--command",
        sql,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: psqlEnvironment,
      },
    ).trim();
  } catch {
    throw new Error("psql could not run a statement against DATABASE_URL");
  }
}

/**
 * Waits for the database to accept connections. Compose already gates the app
 * on the database's health check, but a database that restarts underneath the
 * application should not turn into a failed deploy.
 */
function waitForDatabase() {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      query("SELECT 1");
      return;
    } catch {
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

waitForDatabase();

// to_regclass answers without raising when the table does not exist, which is
// exactly the state of a database that has never been migrated. The count has
// to be a second statement: naming a missing table anywhere in a query is a
// parse error, so it cannot be folded into a CASE.
let migrationsApplied = 0;
if (
  query("SELECT to_regclass('public._prisma_migrations') IS NOT NULL") === "t"
) {
  migrationsApplied = Number(
    query(
      "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL",
    ),
  );
}

if (migrationsApplied > 0) {
  fail(
    `no field encryption key at ${keyPath}, but this database already has ` +
      `${migrationsApplied} applied migrations. Refusing to generate one: a new key ` +
      "cannot read fields written under the old one, and the usual cause of this " +
      "message is a data volume that was not mounted. Restore the original key file, " +
      "or set OPENBRF_ENCRYPTION_KEY to its value.",
  );
}

// The format the API expects: 32 bytes, lowercase hex, one trailing newline.
const key = randomBytes(KEY_LENGTH_BYTES).toString("hex");
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
writeFileSync(keyPath, `${key}\n`, { encoding: "utf8", mode: 0o600 });

log(`generated a field encryption key at ${keyPath}`);
log(
  "back it up together with the database. Losing the key loses every encrypted field: " +
    "contact details and personal identity numbers cannot be recovered from a database " +
    "backup alone. See docs/backup-and-restore.md.",
);

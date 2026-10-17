// Generates the database passwords no variable supplies, and keeps each where
// only the services that use it can read it.
//
//   node docker/credentials.mjs superuser   the superuser-password service,
//                                           before the database starts
//   node docker/credentials.mjs runtime     the migrate service, before it
//                                           constrains the runtime role
//
// and ensurePassword(), which docker/schema-owner.mjs calls for the owner's.
//
// An operator need not supply any of the three. A platform that hands every
// variable of a stack to every one of its services - Coolify does - would
// otherwise give the application's container the superuser's and the owner's
// passwords, which its entrypoint refuses to start with, rightly: whatever a
// container is given it holds for as long as it runs. A password generated
// here is on a volume instead, and the application's container mounts neither
// of the volumes that hold the superuser's and the owner's
// (docker/database-url.mjs, PASSWORD_FILES).
//
// A variable that is set still wins, so an instance that has always supplied
// its passwords keeps working (docs/deployment.md, "The database passwords").
//
// Two of the three can be generated on any boot, because a deploy sets them
// on their roles on every `up`: the schema-owner service the owner's
// (docker/schema-owner.sql, ALTER ROLE ... PASSWORD), the migrate service the
// runtime role's. Each is read from its volume only after it has been set, so
// one generated on a later boot replaces nothing still in use. That is on
// purpose, and unlike the field encryption key: refusing a later boot that
// finds no owner's password would refuse every upgrade from a release that
// had the variable only, and every restore into a new stack, both of which
// meet a database that exists and an owner's volume that is empty.
//
// The superuser's cannot. The database image reads it once, when it
// initialises an empty volume, so it is generated on a first boot and on no
// other, the same rule the field encryption key follows (first-boot.mjs).
//
// Node built-ins only, like the rest of docker/, so this stays readable and
// runnable inside the image an operator is debugging.

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { fail, PASSWORD_FILES, passwordIn } from "./database-url.mjs";

/** As many bytes as the field encryption key, written as hex. */
const PASSWORD_LENGTH_BYTES = 32;

/**
 * Where the superuser-password service sees the database's volume, read-only:
 * whether it holds a database yet is how a first boot is told from a later one.
 */
const DATABASE_VOLUME = "/postgres-data";

/**
 * Entries a volume can hold before anything wrote to it: a filesystem made for
 * the volume alone has lost+found at its root.
 */
const EMPTY_VOLUME_ENTRIES = new Set(["lost+found"]);

function log(message) {
  console.log(`openbrf: ${message}`);
}

/** The errors a volume owned by another user gives, the usual cause. */
const PERMISSION_ERRORS = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Writes a password whole or not at all: to a file of its own, renamed over
 * the old one, so a boot interrupted half way leaves no truncated password for
 * the next one to read.
 *
 * The file of its own has a random name. One named after the process alone
 * would be on the volume still after a boot stopped between the write and the
 * rename, and a container that came back with the same pid - in a container
 * the pids repeat from boot to boot - would find it there and stop on every
 * boot after.
 */
export function writePassword(file, password, mode) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, password, { encoding: "utf8", mode, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The error to report is the one that stopped the write.
    }
    const code = String(error?.code ?? error);
    fail(
      `${file} cannot be written (${code}).` +
        (PERMISSION_ERRORS.has(code)
          ? " A named volume inherits the image's ownership; a bind mount " +
            "does not, so a host directory has to be chowned to uid 1000 first."
          : ""),
    );
  }
}

/**
 * The password a file holds, generated into it first when it holds none.
 * Only for a password the deploy sets on every `up`, so that one generated on
 * a later boot replaces nothing anybody else still has. It therefore asks
 * nothing about the boot, as superuser() below has to (see the top of this
 * file).
 */
export function ensurePassword(file, mode = 0o600) {
  const existing = passwordIn(file);
  if (existing !== "") {
    return existing;
  }
  const password = randomBytes(PASSWORD_LENGTH_BYTES).toString("hex");
  writePassword(file, password, mode);
  return password;
}

/** Whether the database's volume holds anything yet. */
function databaseInitialised() {
  let entries;
  try {
    entries = readdirSync(DATABASE_VOLUME);
  } catch (error) {
    return fail(
      `the database's volume is not readable at ${DATABASE_VOLUME} ` +
        `(${String(error?.code ?? error)}), so this service cannot tell a ` +
        "first boot from a later one. docker-compose.prod.yml mounts it " +
        "there, read-only.",
    );
  }
  return entries.some((entry) => !EMPTY_VOLUME_ENTRIES.has(entry));
}

/**
 * The superuser's password, in place before the database starts, which reads
 * it from POSTGRES_PASSWORD_FILE.
 *
 * The file is readable by every user in the containers that mount its volume,
 * because the database image reads it as postgres, which is not the user this
 * runs as and cannot be given the file. Those containers are this one, the
 * database and schema-owner, all of which hold the password by design.
 */
function superuser() {
  const file = PASSWORD_FILES.superuser;
  const supplied = process.env.POSTGRES_PASSWORD ?? "";

  // An instance that supplies the password, which every instance before this
  // service did. Written to the volume either way, so the database finds it
  // there, and so that the env file need not hold it from now on.
  if (supplied !== "") {
    if (passwordIn(file) !== supplied) {
      writePassword(file, supplied, 0o644);
    }
    log("the database superuser's password is the one in POSTGRES_PASSWORD");
    return;
  }

  if (passwordIn(file) !== "") {
    log("the database superuser's password is in place");
    return;
  }

  // No password and a database that already exists: the database was
  // initialised with a password this volume no longer holds - usually because
  // the volume was removed, or never mounted. A new one would be refused at
  // the first login, so none is made.
  if (databaseInitialised()) {
    fail(
      `no database superuser's password at ${file}, but the database's ` +
        "volume already holds a database, which keeps the password it was " +
        "initialised with. Refusing to generate one the database would not " +
        "take. Set POSTGRES_PASSWORD to that password for one `up`, which " +
        'writes it here; if it is lost, docs/deployment.md, "The database ' +
        'passwords", says how to set a new one.',
    );
  }

  writePassword(
    file,
    randomBytes(PASSWORD_LENGTH_BYTES).toString("hex"),
    0o644,
  );
  log(`generated the database superuser's password at ${file}`);
}

/**
 * The runtime role's password, for the migrate service to set on the role and
 * the application to connect with. Called only when neither RUNTIME_DB_PASSWORD
 * nor DATABASE_URL_RUNTIME is set.
 */
function runtime() {
  const file = PASSWORD_FILES.runtime;
  if (passwordIn(file) !== "") {
    log("the runtime role's password is in place");
    return;
  }
  ensurePassword(file);
  log(`generated the runtime role's password at ${file}`);
}

if (import.meta.main) {
  if (process.argv[2] === "superuser") {
    superuser();
  } else if (process.argv[2] === "runtime") {
    runtime();
  } else {
    fail(
      `credentials.mjs takes superuser or runtime, not ${String(process.argv[2])}.`,
    );
  }
}

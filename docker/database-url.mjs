// Builds the PostgreSQL connection URLs the entrypoint needs, and takes one
// apart again.
//
// The assembly happens here rather than in docker-compose.prod.yml because a
// password is a URL component. One holding :, /, @, ? or # has to be
// percent-encoded, and compose interpolation cannot encode anything: left raw,
// such a password produces a URL that names a different host, a different port
// or a truncated database, and the deploy fails with a connection error rather
// than with a configuration error.
//
// Only one of the two is ever written to a stream:
//
//   node docker/database-url.mjs runtime   openbrf_app, RUNTIME_DB_PASSWORD
//
// The shell has to export DATABASE_URL_RUNTIME for the server it execs, and a
// value cannot cross from a child process into its parent's environment any
// other way. That URL carries the runtime role's password, which the server
// holds by design and which owns nothing: it cannot disable the triggers that
// keep the member register and the audit log append-only.
//
// The owner's connection is deliberately not available here. It is assembled by
// ownerUrl() inside whichever process needs it - see docker/with-owner-url.mjs -
// and handed to that process's child through its environment, so it is never
// printed, never a shell variable and never an argument. The owner is the role
// that can walk past the append-only guards, so the difference matters.
//
// The taking apart is for psql, which reads a connection string as an argument.
// An argument is in /proc/<pid>/cmdline, which every process in the container
// can read; an environment is not, so the password travels in PGPASSWORD and
// the argument carries the rest. passwordOf and withoutPassword do that split
// in-process for first-boot.mjs and harden-runtime-role.mjs; neither prints.
//
// A URL that cannot be read as one is refused rather than passed on: it cannot
// be taken apart, and passing it on puts the password straight back into the
// argument the taking apart exists to keep it out of.
//
// The runtime role's name is not configurable: prisma/sql/harden-runtime-role.sql
// creates and constrains that one role, by name.
//
// Node built-ins only, like the rest of docker/, so it stays readable and
// runnable inside the image an operator is debugging.

const host = process.env.POSTGRES_HOST ?? "db";
const port = process.env.POSTGRES_PORT ?? "5432";
const database = process.env.POSTGRES_DB ?? "openbrf";

const ROLES = new Map([
  [
    "owner",
    {
      user: process.env.POSTGRES_USER ?? "openbrf",
      secret: "POSTGRES_PASSWORD",
    },
  ],
  ["runtime", { user: "openbrf_app", secret: "RUNTIME_DB_PASSWORD" }],
]);

/**
 * Parses a connection URL, or refuses it when it cannot be read as one.
 *
 * libpq accepts one shape the URL parser rejects: an authority whose host is
 * empty, as in postgresql://user:password@/db?host=/var/run/postgresql. Nothing
 * here can see into such a string, so nothing here can take the password out of
 * it, and handing it to psql whole puts the owner's password into
 * /proc/<pid>/cmdline - the one outcome this file exists to prevent, arrived at
 * silently and only by the operators whose connection form the parser does not
 * cover. It is refused instead, and the entrypoint stops on the refusal.
 *
 * The refusal costs no connection that works. Prisma reads DATABASE_URL with a
 * URL parser of its own and rejects the same shape - P1013, "empty host in
 * database URL" - so an instance carrying one cannot reach the migrations in
 * step 4 whatever happens here; passing it on buys nothing but the leak. The
 * spelling both parsers accept names a host and puts the socket directory in a
 * query parameter, as
 * postgresql://user:password@localhost/db?host=/var/run/postgresql, and that
 * one is split here like any other.
 *
 * Nothing derived from the string is ever reported: a password containing a
 * delimiter moves the boundaries of every other component in it, so even the
 * host is not safe to echo. The message names the variable and the shape to
 * write, and quotes nothing the operator set.
 */
function parseUrl(url, variable) {
  try {
    return new URL(url);
  } catch {
    throw new Error(
      `${variable} cannot be read as a connection URL, so the password in it ` +
        "cannot be kept out of psql's arguments, which every process in the " +
        "container can read. Write it as " +
        "postgresql://user:password@host:port/database, percent-encoding the " +
        "password; a Unix socket goes in a host query parameter, as " +
        "postgresql://user:password@localhost/database?host=/var/run/postgresql.",
    );
  }
}

/** The password held in a connection URL, decoded, or "" when it holds none. */
export function passwordOf(url, variable) {
  const parsed = parseUrl(url, variable);
  if (parsed.password === "") {
    return "";
  }
  return decodeURIComponent(parsed.password);
}

/** The same connection URL with its password removed. */
export function withoutPassword(url, variable) {
  const parsed = parseUrl(url, variable);
  parsed.password = "";
  return parsed.href;
}

function fail(message) {
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

/** Every component that carries a value an operator chose is encoded. */
function assemble(role) {
  const password = process.env[role.secret];
  if (password === undefined || password === "") {
    fail(
      `${role.secret} is not set, so no connection URL can be built for ${role.user}.`,
    );
  }
  return `postgresql://${encodeURIComponent(role.user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

/**
 * The schema owner's connection, for a process that is about to use it.
 *
 * Returned rather than printed, and there is no subcommand that would print it:
 * this is the credential that can run ALTER TABLE ... DISABLE TRIGGER, so the
 * only place it exists is the memory of the process that needs it and the
 * environment that process hands its child.
 *
 * A DATABASE_URL that is already set is returned unchanged, which is how an
 * operator points the instance at a database they manage themselves.
 */
export function ownerUrl() {
  const supplied = process.env.DATABASE_URL;
  if (supplied !== undefined && supplied !== "") {
    return supplied;
  }
  return assemble(ROLES.get("owner"));
}

if (import.meta.main) {
  // runtime and nothing else. See the note at the top of this file for why this
  // one URL is printed and the owner's never is.
  if (process.argv[2] === "runtime") {
    console.log(assemble(ROLES.get("runtime")));
  } else {
    fail(
      `database-url.mjs takes runtime, not ${String(process.argv[2])}. The owner's connection is not available here: it is built by ownerUrl() in the process that uses it, so that it is never printed.`,
    );
  }
}

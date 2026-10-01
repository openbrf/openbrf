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
//   node docker/database-url.mjs runtime   RUNTIME_DB_ROLE, RUNTIME_DB_PASSWORD
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
// The runtime role's name is RUNTIME_DB_ROLE, openbrf_app when that is unset or
// empty, and prisma/sql/harden-runtime-role.sql reads the same variable. A role
// belongs to the whole PostgreSQL server, so instances sharing one each name
// their own. `node docker/database-url.mjs check-runtime-role` refuses a name
// that cannot be one, before anything connects, and prints nothing otherwise.
// It also refuses a DATABASE_URL_RUNTIME that signs in as another role while
// RUNTIME_DB_PASSWORD asks for the named one to be constrained: the application
// would then run as a role the hardening never touched.
//
// Node built-ins only, like the rest of docker/, so it stays readable and
// runnable inside the image an operator is debugging.

const host = process.env.POSTGRES_HOST ?? "db";
const port = process.env.POSTGRES_PORT ?? "5432";
const database = process.env.POSTGRES_DB ?? "openbrf";

const OWNER = {
  user: process.env.POSTGRES_USER ?? "openbrf",
  secret: "POSTGRES_PASSWORD",
};

/** The name harden-runtime-role.sql falls back to as well. */
const DEFAULT_RUNTIME_ROLE = "openbrf_app";

/**
 * An identifier PostgreSQL takes unquoted and keeps as written: lower case, and
 * at most 63 bytes, the length it truncates a name to.
 */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Names that pass ROLE_NAME but that PostgreSQL will not create as a role: it
 * reserves public and none, and the other three are keywords that name the
 * session's user wherever a role is expected.
 */
const RESERVED_ROLE_NAMES = new Set([
  "public",
  "none",
  "current_user",
  "current_role",
  "session_user",
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

/**
 * The user the owner's connection signs in as: the one in DATABASE_URL when an
 * operator supplied it, POSTGRES_USER otherwise.
 */
function ownerUser() {
  const supplied = process.env.DATABASE_URL;
  if (supplied !== undefined && supplied !== "") {
    return decodeURIComponent(parseUrl(supplied, "DATABASE_URL").username);
  }
  return OWNER.user;
}

/**
 * The runtime role's name, or an error saying why it cannot be one.
 *
 * Refused, with nothing from the value repeated back:
 *
 *   - anything but a plain lower-case identifier. The hardening script quotes
 *     the name wherever it uses it, but a name that needs quoting is a name an
 *     operator types differently in psql than in this variable, and one longer
 *     than 63 characters is silently shortened by the server;
 *   - a name beginning with pg_, which PostgreSQL reserves for its own roles,
 *     and the few others it will not create a role under;
 *   - the owner's own name. The script would then set the owner's password and
 *     the application would connect as the owner, which can disable the
 *     triggers that keep the member register and the audit log append-only.
 */
export function runtimeRole() {
  const configured = process.env.RUNTIME_DB_ROLE;
  const role =
    configured === undefined || configured === ""
      ? DEFAULT_RUNTIME_ROLE
      : configured;
  if (!ROLE_NAME.test(role)) {
    throw new Error(
      "RUNTIME_DB_ROLE has to be a lower-case PostgreSQL role name: a letter " +
        "or an underscore, then letters, digits and underscores, 63 " +
        "characters at most.",
    );
  }
  if (role.startsWith("pg_")) {
    throw new Error(
      "RUNTIME_DB_ROLE may not begin with pg_, which PostgreSQL reserves for " +
        "its own roles.",
    );
  }
  if (RESERVED_ROLE_NAMES.has(role)) {
    throw new Error(
      "RUNTIME_DB_ROLE may not be public, none, current_user, current_role or " +
        "session_user, which PostgreSQL reserves.",
    );
  }
  if (role === ownerUser()) {
    throw new Error(
      "RUNTIME_DB_ROLE names the schema owner. The application needs a role " +
        "of its own: the owner can disable the triggers that keep the member " +
        "register and the audit log append-only.",
    );
  }
  return role;
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
  return assemble(OWNER);
}

/** The runtime role's name, or the process ends saying why it cannot be. */
function checkedRuntimeRole() {
  try {
    return runtimeRole();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Refuses a supplied DATABASE_URL_RUNTIME that would sign the application in as
 * a role it should not run as. Nothing from the URL is repeated back.
 *
 * In every mode a user query parameter is refused: pg-connection-string lets it
 * override the URL's username, so the user checked here would not be the one
 * that signs in.
 *
 * With RUNTIME_DB_PASSWORD set, the user has to be the role the entrypoint
 * constrains. Without it the operator manages the role and the URL is theirs
 * to write, except that it may not sign in as the owner.
 */
function checkedRuntimeUrl() {
  const supplied = process.env.DATABASE_URL_RUNTIME;
  if (supplied === undefined || supplied === "") {
    return;
  }
  const password = process.env.RUNTIME_DB_PASSWORD;
  const constrained = password !== undefined && password !== "";
  try {
    const parsed = parseUrl(supplied, "DATABASE_URL_RUNTIME");
    if (parsed.searchParams.has("user")) {
      fail(
        "DATABASE_URL_RUNTIME carries a user query parameter, which " +
          "overrides the user in the URL, so the role checked here would not " +
          "be the one the application signs in as. Remove it and put the " +
          "role in the URL's user instead.",
      );
    }
    const user = decodeURIComponent(parsed.username);
    if (!constrained) {
      if (user === ownerUser()) {
        fail(
          "DATABASE_URL_RUNTIME signs in as the schema owner. The application " +
            "needs a role of its own: the owner can disable the triggers that " +
            "keep the member register and the audit log append-only.",
        );
      }
      return;
    }
    if (user !== runtimeRole()) {
      fail(
        "DATABASE_URL_RUNTIME signs in as a role other than the one " +
          "RUNTIME_DB_PASSWORD has this entrypoint constrain, RUNTIME_DB_ROLE " +
          `or ${DEFAULT_RUNTIME_ROLE}, so the application would run as a role ` +
          "that was never hardened. Make the two the same, or unset RUNTIME_DB_PASSWORD " +
          "to manage the role yourself.",
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  // runtime prints the one URL that is ever printed - see the note at the top
  // of this file for why the owner's never is - and check-runtime-role prints
  // nothing unless it refuses.
  if (process.argv[2] === "runtime") {
    console.log(
      assemble({ user: checkedRuntimeRole(), secret: "RUNTIME_DB_PASSWORD" }),
    );
  } else if (process.argv[2] === "check-runtime-role") {
    checkedRuntimeRole();
    checkedRuntimeUrl();
  } else {
    fail(
      `database-url.mjs takes runtime or check-runtime-role, not ${String(process.argv[2])}. The owner's connection is not available here: it is built by ownerUrl() in the process that uses it, so that it is never printed.`,
    );
  }
}

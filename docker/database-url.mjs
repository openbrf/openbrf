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
// in-process for psql.mjs, which every deploy step that runs psql goes
// through; neither prints.
//
// A URL that cannot be read as one is refused rather than passed on: it cannot
// be taken apart, and passing it on puts the password straight back into the
// argument the taking apart exists to keep it out of.
//
// The runtime role's name is RUNTIME_DB_ROLE, openbrf_app when that is unset or
// empty, and prisma/sql/harden-runtime-role.sql reads the same variable. The
// schema owner's is OWNER_DB_USER, openbrf_owner when that is unset or empty,
// and docker/schema-owner.sql reads that one. A role belongs to the whole
// PostgreSQL server, so instances sharing one each name their own.
// `node docker/database-url.mjs check-runtime-role` refuses a name that cannot
// be one, before anything connects, and prints nothing otherwise. It also
// refuses a DATABASE_URL_RUNTIME that signs in as another role while
// RUNTIME_DB_PASSWORD asks for the named one to be constrained: the application
// would then run as a role the hardening never touched. The database's
// superuser is neither role, and its password is never here.
//
// Node built-ins only, like the rest of docker/, so it stays readable and
// runnable inside the image an operator is debugging.

/**
 * The server and database every connection here goes to: the bundled database
 * unless POSTGRES_HOST, POSTGRES_PORT or POSTGRES_DB names another. Empty is
 * unset, as Compose passes an optional variable nobody set.
 */
export function databaseServer() {
  return {
    host: process.env.POSTGRES_HOST || "db",
    port: process.env.POSTGRES_PORT || "5432",
    database: process.env.POSTGRES_DB || "openbrf",
  };
}

/** The names schema-owner.sql and harden-runtime-role.sql fall back to as well. */
const DEFAULT_OWNER_ROLE = "openbrf_owner";
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
 * Query parameters libpq reads a secret from. psql takes the connection string
 * as an argument, so one of these left in it would put that secret into
 * /proc/<pid>/cmdline, which is what taking the password out exists to avoid.
 */
const SECRET_QUERY_PARAMETERS = ["password", "sslpassword"];

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

/**
 * The same connection URL with its password removed, or an error when a secret
 * would stay in it.
 *
 * libpq also reads a password, and the passphrase of a client key, from the
 * query string. Neither can be moved into the environment the way the URL's own
 * password is - PGPASSWORD is the only variable libpq reads a password from,
 * and a password parameter would win over it anyway - so a URL carrying one is
 * refused, naming the parameter and nothing it holds.
 */
export function withoutPassword(url, variable) {
  const parsed = parseUrl(url, variable);
  for (const name of SECRET_QUERY_PARAMETERS) {
    if (parsed.searchParams.has(name)) {
      throw new Error(
        `${variable} carries a ${name} query parameter, which would reach ` +
          "psql's arguments, where every process in the container can read " +
          "it. Put the password in the URL's own password instead, as " +
          "postgresql://user:password@host:port/database.",
      );
    }
  }
  parsed.password = "";
  return parsed.href;
}

/**
 * Ends the process with a message, or with an error's own message, on stderr.
 * Every script in docker/ stops this way; this file imports nothing, so it is
 * the one the others can all import it from.
 */
export function fail(reason) {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

/**
 * The user a connection URL signs in as, decoded, or an error saying why the
 * URL does not settle it. Nothing from the URL is repeated back.
 *
 * pg and libpq both let a user query parameter override the URL's username, and
 * both take a missing one from PGUSER, so a URL carrying either would sign in
 * as a user other than the one read here. Both are refused.
 */
function signInUser(url, variable) {
  const parsed = parseUrl(url, variable);
  if (parsed.searchParams.has("user")) {
    throw new Error(
      `${variable} carries a user query parameter, which overrides the user ` +
        "in the URL, so the role checked here would not be the one the " +
        "application signs in as. Remove it and put the role in the URL's " +
        "user instead.",
    );
  }
  const user = decodeURIComponent(parsed.username);
  if (user === "") {
    throw new Error(
      `${variable} has to name its user: a missing one is taken from PGUSER, ` +
        "so the role checked here would not be the one that signs in. Write " +
        "it as postgresql://user:password@host:port/database.",
    );
  }
  return user;
}

/**
 * The role name a variable holds, its default when it is unset or empty, or an
 * error saying why it cannot be one.
 *
 * Refused, with nothing from the value repeated back:
 *
 *   - anything but a plain lower-case identifier. The SQL quotes the name
 *     wherever it uses it, but a name that needs quoting is a name an operator
 *     types differently in psql than in this variable, and one longer than 63
 *     characters is silently shortened by the server;
 *   - a name beginning with pg_, which PostgreSQL reserves for its own roles,
 *     and the few others it will not create a role under.
 */
function roleName(variable, fallback) {
  const configured = process.env[variable];
  const role =
    configured === undefined || configured === "" ? fallback : configured;
  if (!ROLE_NAME.test(role)) {
    throw new Error(
      `${variable} has to be a lower-case PostgreSQL role name: a letter ` +
        "or an underscore, then letters, digits and underscores, 63 " +
        "characters at most.",
    );
  }
  if (role.startsWith("pg_")) {
    throw new Error(
      `${variable} may not begin with pg_, which PostgreSQL reserves for ` +
        "its own roles.",
    );
  }
  if (RESERVED_ROLE_NAMES.has(role)) {
    throw new Error(
      `${variable} may not be public, none, current_user, current_role or ` +
        "session_user, which PostgreSQL reserves.",
    );
  }
  return role;
}

/** The schema owner's name, OWNER_DB_USER or openbrf_owner, checked as above. */
export function ownerRole() {
  return roleName("OWNER_DB_USER", DEFAULT_OWNER_ROLE);
}

/**
 * The user the owner's connection signs in as: the one in DATABASE_URL when an
 * operator supplied it, OWNER_DB_USER or its default otherwise.
 */
function ownerUser() {
  const supplied = process.env.DATABASE_URL;
  if (supplied !== undefined && supplied !== "") {
    return signInUser(supplied, "DATABASE_URL");
  }
  return ownerRole();
}

/**
 * The runtime role's name, or an error saying why it cannot be one: refused as
 * roleName() refuses, and when it is the owner's own name. The script would
 * then set the owner's password and the application would connect as the
 * owner, which can disable the triggers that keep the member register and the
 * audit log append-only.
 */
export function runtimeRole() {
  const role = roleName("RUNTIME_DB_ROLE", DEFAULT_RUNTIME_ROLE);
  if (role === ownerUser()) {
    throw new Error(
      "RUNTIME_DB_ROLE names the schema owner. The application needs a role " +
        "of its own: the owner can disable the triggers that keep the member " +
        "register and the audit log append-only.",
    );
  }
  return role;
}

/** Query parameters libpq lets override a connection URL's server or database. */
const SERVER_PARAMETERS = ["host", "hostaddr", "port", "dbname"];

/**
 * Where a connection URL connects, in a form two of them can be compared by.
 * Spelled as the URL spells it, so one server written two ways is refused
 * rather than guessed at.
 */
function serverOf(url, variable) {
  const parsed = parseUrl(url, variable);
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.slice(1)),
    overrides: SERVER_PARAMETERS.map((name) =>
      parsed.searchParams.getAll(name).join("\n"),
    ).join("\0"),
  };
}

/** The server POSTGRES_HOST, POSTGRES_PORT and POSTGRES_DB name, as serverOf. */
function assembledServer() {
  const { host, port, database } = databaseServer();
  return {
    host: host.toLowerCase(),
    port,
    database,
    overrides: SERVER_PARAMETERS.map(() => "").join("\0"),
  };
}

/**
 * Refuses an owner's connection to a server or database other than the one the
 * application's own connection is for. Nothing from either URL is repeated
 * back.
 *
 * Without DATABASE_URL_RUNTIME the application's URL is assembled from
 * POSTGRES_HOST, POSTGRES_PORT and POSTGRES_DB, never from DATABASE_URL, which
 * its container is not given. A DATABASE_URL naming another server would have
 * the runtime role created and constrained there while the application
 * connects to the one those three name: a host that does not resolve, or a
 * database that is not this instance's. Server and database are compared as
 * the URL spells them, so one moved into a query parameter is refused too.
 *
 * With DATABASE_URL_RUNTIME supplied beside RUNTIME_DB_PASSWORD, this service
 * still hardens the role and the application connects by that URL, so the two
 * URLs are compared with each other instead. With DATABASE_URL_RUNTIME alone
 * the operator manages the role, nothing is hardened, and there is nothing to
 * compare.
 */
export function checkRuntimeServer() {
  const runtimeUrl = process.env.DATABASE_URL_RUNTIME;
  const supplied = runtimeUrl !== undefined && runtimeUrl !== "";
  const password = process.env.RUNTIME_DB_PASSWORD;
  if (supplied && (password === undefined || password === "")) {
    return;
  }
  const owner = serverOf(process.env.DATABASE_URL ?? "", "DATABASE_URL");
  const runtime = supplied
    ? serverOf(runtimeUrl, "DATABASE_URL_RUNTIME")
    : assembledServer();
  const elsewhere = ["host", "port", "database", "overrides"].some(
    (part) => owner[part] !== runtime[part],
  );
  if (!elsewhere) {
    return;
  }
  if (supplied) {
    throw new Error(
      "DATABASE_URL names another server or database than " +
        "DATABASE_URL_RUNTIME, so the runtime role would be constrained on " +
        "one and used on the other. Write both for the same server and " +
        "database, spelled the same way, or unset RUNTIME_DB_PASSWORD to " +
        "manage the role yourself.",
    );
  }
  throw new Error(
    "DATABASE_URL names another server or database than POSTGRES_HOST, " +
      "POSTGRES_PORT and POSTGRES_DB, which the application builds its own " +
      "connection from, so the runtime role would be constrained on one and " +
      "used on the other. Set those three to the server and database " +
      "DATABASE_URL names, for this service and the application alike, or " +
      "give both DATABASE_URL_RUNTIME.",
  );
}

/** Every component that carries a value an operator chose is encoded. */
function assemble(role) {
  const password = process.env[role.secret];
  if (password === undefined || password === "") {
    fail(
      `${role.secret} is not set, so no connection URL can be built for ${role.user}.`,
    );
  }
  const { host, port, database } = databaseServer();
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
  let user;
  try {
    user = ownerRole();
  } catch (error) {
    fail(error);
  }
  return assemble({ user, secret: "OWNER_DB_PASSWORD" });
}

/** The runtime role's name, or the process ends saying why it cannot be. */
function checkedRuntimeRole() {
  try {
    return runtimeRole();
  } catch (error) {
    return fail(error);
  }
}

/**
 * Refuses a supplied DATABASE_URL_RUNTIME that would sign the application in as
 * a role it should not run as. Nothing from the URL is repeated back.
 *
 * In every mode a user query parameter and a missing user are refused, see
 * signInUser, because the user checked here would not be the one that signs in.
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
    const user = signInUser(supplied, "DATABASE_URL_RUNTIME");
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
    fail(error);
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

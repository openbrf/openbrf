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
//   node docker/database-url.mjs owner     POSTGRES_USER, POSTGRES_PASSWORD
//   node docker/database-url.mjs runtime   openbrf_app, RUNTIME_DB_PASSWORD
//
// The taking apart is for psql. psql reads a connection string as an argument,
// and an argument is in /proc/<pid>/cmdline, which every process in the
// container can read; the environment is not, so the password travels in
// PGPASSWORD and the argument carries the rest.
//
//   node docker/database-url.mjs password DATABASE_URL
//   node docker/database-url.mjs without-password DATABASE_URL
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

/** The URL held in the named variable, which the caller has to have set. */
function urlFromEnvironment(variable) {
  if (variable === undefined) {
    fail("password and without-password take the name of a variable to read.");
  }
  const url = process.env[variable];
  if (url === undefined || url === "") {
    fail(`${variable} is not set, so there is no connection URL to read.`);
  }
  return url;
}

if (import.meta.main) {
  const requested = process.argv[2];
  const role = ROLES.get(requested ?? "");

  if (role !== undefined) {
    console.log(assemble(role));
  } else if (requested === "password" || requested === "without-password") {
    const variable = process.argv[3];
    const url = urlFromEnvironment(variable);
    // Reported as a refusal rather than as an uncaught throw: the caller is a
    // shell script under `set -e`, and what an operator reads is this line.
    try {
      console.log(
        requested === "password"
          ? passwordOf(url, variable)
          : withoutPassword(url, variable),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  } else {
    fail(
      `database-url.mjs takes ${[...ROLES.keys()].join(", ")}, password or without-password, not ${String(requested)}.`,
    );
  }
}

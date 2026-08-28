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
 * Parses a connection URL, or returns undefined when it is not one.
 *
 * libpq accepts shapes the URL parser rejects - a Unix socket connection puts
 * an empty host in the URL and the directory in a query parameter - and an
 * instance that connects today has to go on connecting. Such a URL is handed to
 * psql unchanged instead, exactly as before; the split below applies to the
 * URLs this script assembles, which is every URL the image builds itself.
 *
 * Nothing derived from the string is ever reported: a password containing a
 * delimiter moves the boundaries of every other component in it, so even the
 * host is not safe to echo.
 */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The password held in a connection URL, decoded, or "" when it holds none. */
export function passwordOf(url) {
  const parsed = parseUrl(url);
  if (parsed === undefined || parsed.password === "") {
    return "";
  }
  return decodeURIComponent(parsed.password);
}

/** The same connection URL with its password removed. */
export function withoutPassword(url) {
  const parsed = parseUrl(url);
  if (parsed === undefined) {
    return url;
  }
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
  } else if (requested === "password") {
    console.log(passwordOf(urlFromEnvironment(process.argv[3])));
  } else if (requested === "without-password") {
    console.log(withoutPassword(urlFromEnvironment(process.argv[3])));
  } else {
    fail(
      `database-url.mjs takes ${[...ROLES.keys()].join(", ")}, password or without-password, not ${String(requested)}.`,
    );
  }
}

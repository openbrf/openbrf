// Prints one PostgreSQL connection URL, assembled from its parts.
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

function fail(message) {
  console.error(`openbrf: ${message}`);
  process.exit(1);
}

const requested = process.argv[2];
const role = ROLES.get(requested ?? "");
if (role === undefined) {
  fail(
    `database-url.mjs takes ${[...ROLES.keys()].join(" or ")}, not ${String(requested)}.`,
  );
}

const password = process.env[role.secret];
if (password === undefined || password === "") {
  fail(
    `${role.secret} is not set, so no connection URL can be built for ${role.user}.`,
  );
}

// Every component that carries a value an operator chose is encoded. A
// delimiter left raw in one of them is read as the delimiter it looks like.
console.log(
  `postgresql://${encodeURIComponent(role.user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`,
);

import { expect, test } from "@playwright/test";
import pg from "pg";

import { jsonBodyOrNothing } from "../src/api";
import {
  appPath,
  productionComposeConfig,
  runInAppContainer,
  serviceLogs,
  stack,
} from "../src/stack";

/**
 * What the deployed image does with the database password, and what it does
 * with a request that is nobody's.
 *
 * Not one of the numbered exit criteria, and none of it is visible from a
 * screen. The password reaches the instance through a connection URL, where the
 * characters an operator may well have in a password are delimiters, and it
 * reaches the container's log the moment anything reports an error that carries
 * the command line it was passed on. A container log is shipped off the host,
 * readable by anyone with Docker access, and the first thing pasted into a bug
 * report.
 */

/** Never the real one: this run has to be able to say it saw no password. */
const DECOY_PASSWORD = "this-must-never-be-logged-4f19";

/**
 * A socket directory no message about connection URLs would name by itself, so
 * a run can tell the URL it passed in from the example in an error message.
 */
const DECOY_SOCKET = "/var/run/openbrf-probe-4f19";

/**
 * The shape the refusal tells an operator to write, and the one thing no other
 * failure prints.
 *
 * Naming DATABASE_URL is not enough on its own to recognise a refusal by: the
 * wait loop's own message names the variable too, and so does the check for a
 * variable that was never set. A run that accepted any of those would stay
 * green on the regression these tests exist to catch - a URL that cannot be
 * split handed to psql whole, refused by nothing, failing thirty seconds later
 * with the password in /proc/<pid>/cmdline for every one of them.
 */
const REFUSAL_SHAPE = "postgresql://user:password@localhost/database?host=";

/** What the wait loop reports, thirty seconds in, when psql never connected. */
const WAITED_FOR_A_DATABASE = "did not accept a connection";

test("the first-boot check reports a failure without the database URL", () => {
  // Thirty attempts, a second apart, before the check gives up.
  test.setTimeout(150_000);

  const { status, output } = runInAppContainer(
    ["node", "/app/docker/first-boot.mjs"],
    {
      // Nothing listens on port 1, so the wait runs out and the failure path
      // is the one that reports it.
      DATABASE_URL: `postgresql://openbrf:${DECOY_PASSWORD}@127.0.0.1:1/openbrf`,
      // A directory of its own, so the check looks for a key, finds none and
      // goes on to the database instead of stopping at the real instance's key.
      OPENBRF_DATA_DIR: "/tmp/first-boot-probe",
      OPENBRF_ENCRYPTION_KEY: "",
    },
    150_000,
  );

  expect(status, "the check refuses to carry on without a database").toBe(1);
  expect(output).toContain(WAITED_FOR_A_DATABASE);

  // psql takes the connection string as an argument, and Node puts the whole
  // command line into the error it throws for a command that failed.
  expect(
    output.includes(DECOY_PASSWORD),
    "the startup log holds no database password",
  ).toBe(false);
  expect(
    output.includes("postgresql://"),
    "the startup log holds no connection URL",
  ).toBe(false);
});

test("a connection URL that cannot be taken apart is refused, not passed on", () => {
  // The socket probe at the end runs the wait loop out, thirty seconds.
  test.setTimeout(210_000);

  // libpq accepts an authority whose host is empty; the URL parser does not.
  // Such a URL cannot be split, so the password in it cannot be moved out of
  // psql's arguments, and the image refuses the boot rather than putting it
  // there. Prisma rejects the same shape (P1013), so nothing that could have
  // migrated is being turned away.
  const unsplittable = `postgresql://openbrf:${DECOY_PASSWORD}@/openbrf?host=${DECOY_SOCKET}`;

  // Both scripts that split a URL, driven as the entrypoint drives them. Were
  // the URL passed on whole instead, each would spend thirty seconds connecting
  // with the password in /proc/<pid>/cmdline and end on the wait loop's own
  // failure - which is also status 1, and also names DATABASE_URL. So the
  // refusal is what is asserted, and the wait loop's message is asserted
  // against: the two together are what distinguish the two endings.
  for (const script of [
    "/app/docker/first-boot.mjs",
    "/app/docker/harden-runtime-role.mjs",
  ]) {
    const { status, output } = runInAppContainer(
      ["node", script],
      {
        DATABASE_URL: unsplittable,
        OPENBRF_DATA_DIR: "/tmp/unsplittable-probe",
        OPENBRF_ENCRYPTION_KEY: "",
      },
      60_000,
    );

    expect(status, `${script} refuses it`).toBe(1);
    // The refusal names the variable to fix and the shape to write.
    expect(output, script).toContain("DATABASE_URL");
    expect(output, `${script} stopped on the refusal`).toContain(REFUSAL_SHAPE);
    expect(
      output.includes(WAITED_FOR_A_DATABASE),
      `${script} never gave psql the URL`,
    ).toBe(false);
    expect(
      output.includes(DECOY_PASSWORD),
      `${script} echoes no password`,
    ).toBe(false);
    expect(
      output.includes(DECOY_SOCKET),
      `${script} echoes nothing from the URL`,
    ).toBe(false);
  }

  // A Unix socket connection is not what is being refused: the spelling that
  // names a host and puts the directory in a query parameter is the one Prisma
  // documents, and it is split like any other. Nothing prints a split URL any
  // more, so what shows it was split is that the wait loop was reached at all -
  // the refusal above stops before psql, this one gets as far as trying.
  const socket = runInAppContainer(
    ["node", "/app/docker/first-boot.mjs"],
    {
      DATABASE_URL: `postgresql://openbrf:${DECOY_PASSWORD}@localhost/openbrf?host=${DECOY_SOCKET}`,
      OPENBRF_DATA_DIR: "/tmp/socket-probe",
      OPENBRF_ENCRYPTION_KEY: "",
    },
    150_000,
  );

  expect(socket.status, "a socket URL that parses is not refused").toBe(1);
  expect(socket.output, "it reached psql instead").toContain(
    WAITED_FOR_A_DATABASE,
  );
  expect(
    socket.output.includes(REFUSAL_SHAPE),
    "a socket URL is not what the refusal is for",
  ).toBe(false);
  expect(
    socket.output.includes(DECOY_PASSWORD),
    "the startup log holds no database password",
  ).toBe(false);
});

test("a password holding URL delimiters reaches the database intact", async () => {
  // Both passwords in stack.env carry ":", "/" and "@". Raw, each of them moves
  // the boundaries of the URL they sit in - a different host, a different port,
  // a truncated name - so this is what percent-encoding is for.
  expect(stack.databaseUrl).toContain("%3A");
  expect(stack.databaseUrl).toContain("%2F");
  expect(stack.databaseUrl).toContain("%40");

  // The role the entrypoint created from that password, reached with a URL
  // built the same way. The application connecting at all is the other half of
  // this, and every spec before this one depends on it.
  const client = new pg.Client({ connectionString: stack.runtimeDatabaseUrl });
  await client.connect();
  try {
    const answer = await client.query<{ reachable: number }>(
      "SELECT 1 AS reachable",
    );
    expect(answer.rows).toEqual([{ reachable: 1 }]);
  } finally {
    await client.end();
  }
});

/**
 * What a production start needs whichever way the runtime role arrives.
 *
 * These are not secrets and guard nothing: no container is started from them,
 * and only the rendered configuration is read.
 */
const COMPOSE_REQUIRED = {
  APP_URL: "https://example.invalid",
  POSTGRES_PASSWORD: "superuser-password-for-rendering",
  OWNER_DB_PASSWORD: "owner-password-for-rendering",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
};

type RenderedService = {
  environment: Record<string, string | null>;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  command?: string[];
  restart?: string;
  depends_on?: Record<string, { condition: string }>;
};

/** One service out of a rendered configuration. */
function renderedService(output: string, name: string): RenderedService {
  const config = JSON.parse(output) as {
    services: Record<string, RenderedService>;
  };
  const service = config.services[name];
  if (service === undefined) {
    throw new Error(`the rendered configuration has no ${name} service`);
  }
  return service;
}

/** The app service's environment out of a rendered configuration. */
function appEnvironment(output: string): Record<string, string | null> {
  return renderedService(output, "app").environment;
}

test("both documented ways to supply the runtime connection reach the container", () => {
  // docs/deployment.md offers two, and the entrypoint acts on both:
  // RUNTIME_DB_PASSWORD, which it turns into the openbrf_app role it creates
  // and constrains, and DATABASE_URL_RUNTIME, for an operator who manages that
  // role themselves. Neither is any use unless docker-compose.prod.yml maps it
  // into the container: a variable that file does not name is simply absent,
  // however carefully the env file sets it, and a documented path that ends
  // there cannot be followed at all.
  const externallyManagedUrl =
    "postgresql://openbrf_app:enc%40ded@db:5432/openbrf";

  const externallyManaged = productionComposeConfig({
    ...COMPOSE_REQUIRED,
    DATABASE_URL_RUNTIME: externallyManagedUrl,
  });
  expect(
    externallyManaged.status,
    `an env file with no RUNTIME_DB_PASSWORD renders: ${externallyManaged.output}`,
  ).toBe(0);
  const managed = appEnvironment(externallyManaged.output);
  expect(managed.DATABASE_URL_RUNTIME).toBe(externallyManagedUrl);
  // Empty, which the entrypoint's -n test and the API's env schema both read
  // as absent, so the entrypoint leaves the operator's role alone.
  expect(managed.RUNTIME_DB_PASSWORD).toBe("");

  const entrypointManaged = productionComposeConfig({
    ...COMPOSE_REQUIRED,
    RUNTIME_DB_PASSWORD: "runtime-password",
  });
  expect(entrypointManaged.status, entrypointManaged.output).toBe(0);
  const ordinary = appEnvironment(entrypointManaged.output);
  expect(ordinary.RUNTIME_DB_PASSWORD).toBe("runtime-password");
  expect(ordinary.DATABASE_URL_RUNTIME).toBe("");

  // With neither, the configuration still renders. Refusing here would report
  // whichever variable was named first as missing, which is wrong half the
  // time; the entrypoint is the only place that can see which of the two
  // arrived, and the test below is what holds it to refusing.
  const neither = productionComposeConfig(COMPOSE_REQUIRED);
  expect(neither.status, neither.output).toBe(0);
  const nothing = appEnvironment(neither.output);
  expect(nothing.RUNTIME_DB_PASSWORD).toBe("");
  expect(nothing.DATABASE_URL_RUNTIME).toBe("");
});

test("mail set where the instance runs reaches the container", () => {
  // docs/deployment.md tells a host to set the mail with these, and the
  // application reads each one (ADR 0024). A variable the compose file does not
  // map is simply absent in the container, and a host whose OPENBRF_MAIL_DRIVER
  // never arrived would find the board's own settings sending instead. Both
  // drivers' variables at once, because only the mapping is under test here:
  // nothing starts from this configuration, and the application is what
  // refuses the two together.
  const mail = {
    OPENBRF_MAIL_DRIVER: "http-api",
    OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
    OPENBRF_MAIL_FROM_NAME: "Brf Eksemplet",
    OPENBRF_MAIL_REPLY_TO: "styrelsen@eksemplet.example",
    OPENBRF_SMTP_HOST: "smtp.host.example",
    OPENBRF_SMTP_PORT: "2525",
    OPENBRF_SMTP_SECURE: "true",
    OPENBRF_SMTP_USER: "relay",
    OPENBRF_SMTP_PASSWORD: "relay-password-for-rendering",
    OPENBRF_MAIL_API_URL: "https://api.mail.example/v1",
    OPENBRF_MAIL_API_KEY: "key-for-rendering",
    OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "mail.example",
  };

  const set = productionComposeConfig({
    ...COMPOSE_REQUIRED,
    RUNTIME_DB_PASSWORD: "runtime-password",
    ...mail,
  });
  expect(set.status, set.output).toBe(0);
  const environment = appEnvironment(set.output);
  for (const [name, value] of Object.entries(mail)) {
    expect(environment[name], name).toBe(value);
  }

  // Unset, each arrives empty, which the application reads as absent: the
  // mail is then the board's own settings, as on every instance before.
  const unset = productionComposeConfig({
    ...COMPOSE_REQUIRED,
    RUNTIME_DB_PASSWORD: "runtime-password",
  });
  expect(unset.status, unset.output).toBe(0);
  const nothing = appEnvironment(unset.output);
  for (const name of Object.keys(mail)) {
    expect(nothing[name], name).toBe("");
  }
});

test("both database passwords the stack is built from are required by the compose file", () => {
  // The database container is created from them - the superuser's, and the
  // schema owner's it creates openbrf_owner with - so there is no second way to
  // supply either and nothing further on that could report its absence better.
  for (const name of ["POSTGRES_PASSWORD", "OWNER_DB_PASSWORD"] as const) {
    const rest = Object.fromEntries(
      Object.entries(COMPOSE_REQUIRED).filter(([key]) => key !== name),
    );
    const { status, output } = productionComposeConfig({
      ...rest,
      RUNTIME_DB_PASSWORD: "runtime-password",
    });

    expect(status, `rendering fails without ${name}`).not.toBe(0);
    // The compose file's own wording, so an unrelated rendering error cannot
    // stand in for it.
    expect(output).toContain(`set ${name} in the env file`);
  }
});

test("the owner's credentials go to the migrate service and not to the application", () => {
  const { status, output } = productionComposeConfig({
    ...COMPOSE_REQUIRED,
    RUNTIME_DB_PASSWORD: "runtime-password",
  });
  expect(status, output).toBe(0);

  // The deploy steps run in a container of their own, which exits once they
  // have, and the application starts only after they succeeded.
  const migrate = renderedService(output, "migrate");
  expect(migrate.command).toEqual(["migrate"]);
  expect(migrate.restart).toBe("no");
  expect(migrate.environment.OWNER_DB_PASSWORD).toBe(
    COMPOSE_REQUIRED.OWNER_DB_PASSWORD,
  );
  const app = renderedService(output, "app");
  expect(app.depends_on?.migrate?.condition).toBe(
    "service_completed_successfully",
  );

  // Neither the superuser's password nor the owner's is anywhere in the
  // application's configuration, under any name.
  for (const name of [
    "POSTGRES_PASSWORD",
    "OWNER_DB_PASSWORD",
    "DATABASE_URL",
    "POSTGRES_USER",
  ]) {
    expect(Object.keys(app.environment), name).not.toContain(name);
  }
  const values = Object.values(app.environment).map((value) => value ?? "");
  for (const secret of [
    COMPOSE_REQUIRED.POSTGRES_PASSWORD,
    COMPOSE_REQUIRED.OWNER_DB_PASSWORD,
  ]) {
    expect(
      values.some((value) => value.includes(secret)),
      "no value in the application's environment carries a database owner's password",
    ).toBe(false);
  }
  // And the superuser's password is the database container's alone.
  expect(Object.keys(migrate.environment)).not.toContain("POSTGRES_PASSWORD");
});

test("the instance's own containers run without capabilities or a writable root", () => {
  const { status, output } = productionComposeConfig({
    ...COMPOSE_REQUIRED,
    RUNTIME_DB_PASSWORD: "runtime-password",
  });
  expect(status, output).toBe(0);

  for (const name of ["migrate", "app"]) {
    const service = renderedService(output, name);
    expect(service.read_only, `${name} has a read-only root`).toBe(true);
    expect(service.cap_drop, `${name} drops every capability`).toEqual(["ALL"]);
    expect(service.security_opt, `${name} gains no privileges`).toContain(
      "no-new-privileges:true",
    );
  }
  expect(renderedService(output, "db").security_opt).toContain(
    "no-new-privileges:true",
  );
});

test("the entrypoint refuses a production start with no runtime connection", () => {
  test.setTimeout(120_000);

  // Now that neither runtime variable is required by the compose file, this
  // refusal is the only thing between an operator who set up neither and an
  // application connecting as the schema owner - which could disable the
  // triggers keeping the member register and the audit log append-only. It is
  // the first thing the entrypoint checks, in either of its two jobs.
  const { status, output } = runInAppContainer(
    ["/usr/local/bin/openbrf-entrypoint", "true"],
    {
      RUNTIME_DB_PASSWORD: "",
      DATABASE_URL_RUNTIME: "",
      NODE_ENV: "production",
    },
    120_000,
  );

  expect(status, `the boot stops: ${output}`).toBe(1);
  // The refusal names both ways out, so an operator reads what to set rather
  // than which variable happened to be checked first.
  expect(output).toContain(
    "Neither RUNTIME_DB_PASSWORD nor DATABASE_URL_RUNTIME is set",
  );
  expect(
    output.includes("openbrf: starting"),
    "the server was never reached",
  ).toBe(false);
});

test("the application's container refuses to start holding an owner credential", () => {
  test.setTimeout(120_000);

  // The compose file gives the owner's credentials to the migrate service
  // alone. A configuration that hands one to the application's container
  // anyway - an older compose file, or one written by hand - is refused by
  // name rather than started with it.
  const decoyUrl = `postgresql://openbrf_owner:${DECOY_PASSWORD}@db:5432/openbrf`;
  for (const [name, value] of [
    ["OWNER_DB_PASSWORD", DECOY_PASSWORD],
    ["POSTGRES_PASSWORD", DECOY_PASSWORD],
    ["DATABASE_URL", decoyUrl],
  ] as const) {
    const { status, output } = runInAppContainer(
      ["/usr/local/bin/openbrf-entrypoint", "true"],
      { [name]: value },
      60_000,
    );

    expect(status, `${name} stops the start: ${output}`).toBe(1);
    expect(output, name).toContain(
      `${name} is set in the application's container`,
    );
    expect(output.includes("openbrf: starting"), name).toBe(false);
    expect(output.includes(DECOY_PASSWORD), `${name} is not echoed`).toBe(
      false,
    );
  }
});

test("an unknown API path answers JSON, and a client route answers the client", async ({
  request,
}) => {
  // One container serves both, so the last route a request meets decides which
  // of the two it belongs to. The query string is part of the request URL and
  // no part of that decision.
  for (const path of ["/api", "/api?probe=1", "/api/not-a-route?probe=1"]) {
    const response = await request.get(`${stack.baseUrl}${path}`, {
      failOnStatusCode: false,
    });
    expect(response.status(), path).toBe(404);
    expect(jsonBodyOrNothing(await response.text()), path).toEqual({
      reason: "not-found",
    });
  }

  // And a route the client router owns is the client's, on a reload as much as
  // on a first visit. Under /app now: the root is the association's own public
  // website, and the two are told apart by a whole path segment.
  const client = await request.get(`${stack.baseUrl}${appPath("/settings")}`, {
    failOnStatusCode: false,
  });
  expect(client.status()).toBe(200);
  expect(await client.text()).toContain("<!doctype html>");
});

test("no request path under the client's prefix can name the file it serves", async ({
  request,
}) => {
  // The route that answers everything the client router owns sends one file by
  // a literal name, resolved against a directory fixed when the static plugin
  // was registered. Nothing in a request reaches the path that is read, and
  // these are the shapes that would show it if anything did: a path that names
  // a real system file, two traversals percent-encoded so they survive a
  // client's own normalisation, and a null byte, which used to truncate a name
  // in the layer underneath.
  const index = await request.get(`${stack.baseUrl}${appPath()}`, {
    failOnStatusCode: false,
  });
  expect(index.status()).toBe(200);
  const client = await index.text();
  expect(client).toContain("<!doctype html>");

  for (const path of [
    appPath("/etc/passwd"),
    appPath("/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd"),
    appPath("/..%2f..%2f..%2fetc%2fpasswd"),
    appPath("/settings/%2e%2e%2f%2e%2e%2fetc%2fhostname"),
    appPath("/index.html%00.png"),
  ]) {
    const response = await request.get(`${stack.baseUrl}${path}`, {
      failOnStatusCode: false,
    });
    // The same file, byte for byte, whatever was asked for. Comparing against
    // the client rather than looking for the absence of a system file is what
    // makes this fail for any other file too, including one inside the web
    // root that was never meant to be reachable by name.
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toBe(client);
  }
});

test("the same paths at the root are the website's not-found, and set no cookie", async ({
  request,
}) => {
  // The root belongs to the association's public website now, so a traversal
  // shape aimed at it meets the page lookup rather than the client's file
  // route. What it must get is the website's own not-found page: a 404, HTML,
  // and - the part that is easy to lose - no session cookie, because nothing on
  // the public site may start a session for a visitor who has not asked for
  // one.
  for (const path of [
    "/etc/passwd",
    "/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/..%2f..%2f..%2fetc%2fpasswd",
    "/index.html%00.png",
    "/en-sida-som-inte-finns",
  ]) {
    const response = await request.get(`${stack.baseUrl}${path}`, {
      failOnStatusCode: false,
    });
    expect(response.status(), path).toBe(404);
    const headers = response.headers();
    expect(headers["content-type"], path).toContain("text/html");
    expect(headers["set-cookie"], path).toBeUndefined();
    const body = await response.text();
    expect(body, path).toContain("<!doctype html>");
    expect(body.includes("<script"), path).toBe(false);
  }
});

test("the deploy and the boot that just happened logged no database password", () => {
  // The deploy steps split the owner's password out of its URL to hand it to
  // psql in PGPASSWORD, and the application's entrypoint prints the runtime URL
  // into a command substitution to export it. Neither may reach a log, and this
  // is what holds that true rather than an argument that it is true. A
  // container's log is what gets shipped off the host, read by anyone with
  // Docker access and pasted into a bug report.
  const migrateLogs = serviceLogs("migrate");
  const appLogs = serviceLogs("app");

  // The deploy and the boot really are in these logs, so the absences below
  // mean something: the step that reads the owner's password, the end of the
  // deploy, and the exec.
  expect(migrateLogs).toContain("constraining the application database role");
  expect(migrateLogs).toContain("the database is ready for the application");
  expect(appLogs).toContain("openbrf: starting");

  const logs = `${migrateLogs}\n${appLogs}`;
  for (const [name, secret] of [
    ["POSTGRES_PASSWORD", stack.superuserPassword],
    ["OWNER_DB_PASSWORD", stack.ownerPassword],
    ["RUNTIME_DB_PASSWORD", stack.runtimePassword],
  ] as const) {
    expect(logs.includes(secret), `the log holds no ${name}`).toBe(false);
    // The URLs the entrypoint assembles carry the password encoded, which is
    // the shape a leaked URL would have rather than a leaked value.
    expect(
      logs.includes(encodeURIComponent(secret)),
      `the log holds no encoded ${name}`,
    ).toBe(false);
  }

  // And no connection URL carrying any credentials at all, in case a future
  // password does not happen to contain the characters the two above do.
  expect(
    /postgresql:\/\/[^\s/]*:[^\s/]*@/.test(logs),
    "the log holds no connection URL with a password in it",
  ).toBe(false);
});

test("a body that is not JSON is reported by its status", () => {
  // The submit endpoint is called with every status kept, so the body can be a
  // proxy's error page or nothing at all. Reading it has to leave the caller's
  // assertion about the status the thing that fails.
  expect(jsonBodyOrNothing('{"reason":"self-signup-disabled"}')).toEqual({
    reason: "self-signup-disabled",
  });
  expect(jsonBodyOrNothing("<!doctype html><html></html>")).toEqual({});
  expect(jsonBodyOrNothing("")).toEqual({});
  expect(jsonBodyOrNothing("null")).toEqual({});
});

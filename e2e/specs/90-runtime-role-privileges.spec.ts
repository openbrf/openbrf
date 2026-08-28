import { expect, test } from "@playwright/test";
import pg from "pg";
import { PgBoss } from "pg-boss";

import { runInAppContainer, stack } from "../src/stack";

/**
 * What the application's own database role can and cannot do, and that it is
 * the only role the running application has.
 *
 * Not one of the numbered exit criteria: it is the evidence behind the two
 * roles the deployment uses. `prisma/sql/harden-runtime-role.sql` constrains
 * openbrf_app so a bug in the application cannot rewrite the member register or
 * the audit log, and it grants CREATE on the pgboss schema so a queue can be
 * declared at runtime. Both halves are checked here, against the role the
 * entrypoint really created, because a grant nothing exercises is one that
 * stops working quietly.
 *
 * Most of it connects as openbrf_app itself rather than through the
 * application, so a failure names the privilege rather than a screen. The last
 * test is the exception and looks at the server process instead: constraining
 * one role proves nothing if the owner's credentials are still sitting in the
 * environment the server can read.
 */

const suffix = process.hrtime.bigint().toString(36);
const QUEUE = `runtime-role-${suffix}`;
const SCRATCH_TABLE = `runtime_role_${suffix}`;

async function asRuntimeRole<T>(
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: stack.runtimeDatabaseUrl });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** The SQLSTATE a statement failed with, or undefined if it succeeded. */
async function sqlStateOf(statement: string): Promise<string | undefined> {
  return asRuntimeRole(async (client) => {
    try {
      await client.query(statement);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
}

/** PostgreSQL's insufficient_privilege. */
const PERMISSION_DENIED = "42501";

/**
 * A rewrite of the statutory member register, which nothing may be allowed to
 * do. The WHERE matches nothing on purpose: the refusal is on the privilege,
 * before any row is looked at.
 */
const TAMPER_STATEMENT = `UPDATE public.member_register_entry SET "recordedLastName" = 'Tampered' WHERE id = 'no-such-entry'`;

test("the application's role creates a queue and enqueues a job", async () => {
  test.setTimeout(60_000);

  // The application's own configuration: its connection, its schema, and
  // migration off, because the schema is the owner's to install.
  const boss = new PgBoss({
    connectionString: stack.runtimeDatabaseUrl,
    schema: "pgboss",
    migrate: false,
    application_name: "openbrf-e2e-privileges",
  });

  const errors: Error[] = [];
  boss.on("error", (error) => errors.push(error));

  await boss.start();
  try {
    // What a feature module does when it first needs a queue - the move-out
    // board reminder among them. There is no deploy step between installing a
    // plugin and its first job.
    await boss.createQueue(QUEUE);

    const delivered = new Promise<{ apartmentNumber: string }>((resolve) => {
      void boss.work<{ apartmentNumber: string }>(QUEUE, async (jobs) => {
        for (const job of jobs) {
          resolve(job.data);
        }
      });
    });

    const jobId = await boss.send(QUEUE, { apartmentNumber: "1201" });
    expect(jobId, "the job was accepted").not.toBeNull();
    await expect(delivered).resolves.toEqual({ apartmentNumber: "1201" });
  } finally {
    await boss.stop({ graceful: false });
  }

  expect(errors.map((error) => error.message)).toEqual([]);
});

test("the grant reaches into the job schema and no further", async () => {
  // The grant, exercised rather than asserted: this is the statement that
  // starts failing the day CREATE ON SCHEMA pgboss is dropped.
  expect(
    await sqlStateOf(`CREATE TABLE pgboss.${SCRATCH_TABLE} (id int)`),
    "openbrf_app may create objects in the job schema",
  ).toBeUndefined();
  await asRuntimeRole(async (client) => {
    await client.query(`DROP TABLE pgboss.${SCRATCH_TABLE}`);
  });

  // And nowhere else. Migrations stay the owner's, so the application cannot
  // reshape the schema the statutory tables live in, nor disable the triggers
  // that guard them.
  expect(
    await sqlStateOf(`CREATE TABLE public.${SCRATCH_TABLE} (id int)`),
    "openbrf_app may not create objects in the application schema",
  ).toBe(PERMISSION_DENIED);
});

test("the application's role still cannot rewrite the statutory archive", async () => {
  // Refused on the privilege rather than by the append-only trigger. Both
  // exist, and this is the one an owner could not switch off.
  expect(
    await sqlStateOf(TAMPER_STATEMENT),
    "the member register is insert and read only for the application",
  ).toBe(PERMISSION_DENIED);

  expect(
    await sqlStateOf(
      `DELETE FROM public.audit_log_entry WHERE id = 'no-such-entry'`,
    ),
    "the audit log is evidence, and the application cannot erase it",
  ).toBe(PERMISSION_DENIED);
});

/**
 * Read inside the container, about the server process rather than about this
 * one.
 *
 * `docker compose exec` starts a process from the container's configured
 * environment, which still carries both database passwords - that is what the
 * entrypoint was handed. The server is a different process: the entrypoint
 * dropped the owner's credentials before it exec'd into it, so its
 * /proc/<pid>/environ is the thing worth reading, and this session's own
 * POSTGRES_PASSWORD is what to look for in it.
 *
 * Every connection URL found there is then used, from inside the container,
 * against the member register. Naming the variables that must be gone would
 * only prove the names are gone; using what is left proves the credentials the
 * server actually holds cannot rewrite the register.
 *
 * Nothing but a verdict crosses back: no value from that environment is
 * printed, because the output of a failing suite ends up in a log.
 */
const APPLICATION_PROCESS_PROBE = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const pid = fs.readdirSync("/proc").find((entry) => {
  if (!/^[0-9]+$/.test(entry)) return false;
  try {
    const argv = fs
      .readFileSync("/proc/" + entry + "/cmdline", "utf8")
      .split("\\0")
      .filter(Boolean);
    // The server, and not tini: pid 1 was told to run this command, so its own
    // arguments name the script too, and its environment is the one the
    // entrypoint was handed rather than the one it passed on.
    const program = (argv[0] ?? "").split("/").pop();
    return program === "node" && argv.includes("dist/main.js");
  } catch {
    return false;
  }
});
if (pid === undefined) throw new Error("no application process is running");

const held = fs
  .readFileSync("/proc/" + pid + "/environ", "utf8")
  .split("\\0")
  .filter(Boolean)
  .map((entry) => {
    const at = entry.indexOf("=");
    return [entry.slice(0, at), entry.slice(at + 1)];
  });

const names = held.map(([name]) => name);
const values = held.map(([, value]) => value);

const ownerPassword = process.env.POSTGRES_PASSWORD ?? "";
if (ownerPassword === "") throw new Error("this session has no owner password to look for");
const carriesOwnerPassword = values.some(
  (value) =>
    value.includes(ownerPassword) ||
    value.includes(encodeURIComponent(ownerPassword)),
);

const connections = values.filter((value) => /^postgres(ql)?:\\/\\//.test(value));
const refusals = connections.map((url) => {
  const parsed = new URL(url);
  const password = parsed.password === "" ? "" : decodeURIComponent(parsed.password);
  parsed.password = "";
  try {
    execFileSync(
      "psql",
      ["--quiet", "--no-psqlrc", "--set", "ON_ERROR_STOP=on", parsed.href, "--command", ${JSON.stringify(TAMPER_STATEMENT)}],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: password === "" ? process.env : { ...process.env, PGPASSWORD: password },
      },
    );
    return "accepted";
  } catch (failure) {
    const said = String(failure.stderr ?? "") + String(failure.stdout ?? "");
    return said.includes("permission denied") ? "permission denied" : "refused for another reason";
  }
});

process.stdout.write(JSON.stringify({ names, carriesOwnerPassword, refusals }));
`;

test("the running application holds no credentials but the constrained one", () => {
  test.setTimeout(60_000);

  const { status, output } = runInAppContainer(
    ["node", "-e", APPLICATION_PROCESS_PROBE],
    {},
    60_000,
  );
  expect(status, `the probe ran: ${output}`).toBe(0);

  const seen = JSON.parse(output) as {
    names: string[];
    carriesOwnerPassword: boolean;
    refusals: string[];
  };

  expect(
    seen.names,
    "the application connects as openbrf_app and nothing else",
  ).toContain("DATABASE_URL_RUNTIME");

  // The owner runs migrations, installs the job schema and applies the role
  // hardening, and then has no further business in this container. A table's
  // owner can ALTER TABLE ... DISABLE TRIGGER, so leaving these where the
  // server could read them would put the append-only member register and the
  // audit log back within reach of an application-path compromise.
  for (const name of [
    "DATABASE_URL",
    "POSTGRES_PASSWORD",
    "RUNTIME_DB_PASSWORD",
    "PGPASSWORD",
  ]) {
    expect(
      seen.names,
      `${name} is not in the server's environment`,
    ).not.toContain(name);
  }
  expect(
    seen.carriesOwnerPassword,
    "no variable the server holds carries the owner's password",
  ).toBe(false);

  // And what it does hold cannot rewrite the register.
  expect(
    seen.refusals.length,
    "the server holds a connection URL",
  ).toBeGreaterThan(0);
  for (const refusal of seen.refusals) {
    expect(
      refusal,
      "a connection the server holds is refused the member register",
    ).toBe("permission denied");
  }
});

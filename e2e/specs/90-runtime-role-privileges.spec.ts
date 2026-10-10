import { expect, test } from "@playwright/test";
import pg from "pg";
import { PgBoss } from "pg-boss";

import { ENVIRONMENT_READER_SOURCE } from "../src/environment-reader";
import {
  runAsSuperuser,
  runInAppContainer,
  runSchemaOwner,
  stack,
} from "../src/stack";

/**
 * What the application's own database role can and cannot do, and that it is
 * the only role the running application has.
 *
 * Not one of the numbered exit criteria: it is the evidence behind the roles
 * the deployment uses. `prisma/sql/harden-runtime-role.sql` constrains
 * openbrf_app so a bug in the application cannot rewrite the member register,
 * the audit log or the migration history, while a queue can still be declared
 * at runtime. Both halves are checked here, against the role the migrate
 * service really created, because a grant nothing exercises is one that stops
 * working quietly.
 *
 * Most of it connects as openbrf_app itself rather than through the
 * application, so a failure names the privilege rather than a screen. The last
 * tests are the exception and look at the application's container instead:
 * constraining one role proves nothing if the owner's credentials are anywhere
 * in that container, if the code the owner runs can be changed from inside it,
 * or if the application would serve as the owner when told to.
 *
 * Every statutory table belongs in this file. A table added to that tier
 * without a test here is protected only by a trigger, which the table owner can
 * switch off, and by nothing anybody can see.
 */

const suffix = process.hrtime.bigint().toString(36);
const QUEUE = `runtime-role-${suffix}`;
const SCRATCH_TABLE = `runtime_role_${suffix}`;

/**
 * The schema owner's connection as the application's container would reach
 * it: by the service name, on the compose network.
 */
const OWNER_URL_IN_NETWORK = `postgresql://openbrf_owner:${encodeURIComponent(stack.ownerPassword)}@db:5432/openbrf`;

async function connectedAs<T>(
  connectionString: string,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

async function asRuntimeRole<T>(
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return connectedAs(stack.runtimeDatabaseUrl, use);
}

/** Runs one statement as the schema owner, from the host. */
async function asOwner(statement: string): Promise<void> {
  await connectedAs(stack.databaseUrl, (client) => client.query(statement));
}

/** The single value a superuser query selects, trimmed. */
function superuserValue(query: string): string {
  const { status, output } = runAsSuperuser([
    "--tuples-only",
    "--no-align",
    "--command",
    query,
  ]);
  expect(status, output).toBe(0);
  return output.trim();
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

/** PostgreSQL's check_violation, which the queue guard raises. */
const CHECK_VIOLATION = "23514";

/**
 * A rewrite of the statutory member register, which nothing may be allowed to
 * do. The WHERE matches nothing on purpose: the refusal is on the privilege,
 * before any row is looked at.
 */
const TAMPER_STATEMENT = `UPDATE public.member_register_entry SET "recordedLastName" = 'Tampered' WHERE id = 'no-such-entry'`;

/**
 * The statutory writes the application must be refused, table by table.
 *
 * Written out rather than derived from the hardening script, because a test that
 * read its list from the file it is testing would go green on a file that
 * revoked nothing. Every WHERE matches nothing on purpose: the refusal is on
 * the privilege, before any row is looked at.
 *
 * transfer and lien_note keep UPDATE deliberately - releasing a lien sets
 * releasedOn, and a mis-keyed entry has to be correctable - so only their
 * deletes are here. termination keeps neither: a tenant-ownership that has
 * ceased has no later state to reach.
 */
const REFUSED_STATEMENTS: [string, string][] = [
  ["the member register cannot be rewritten", TAMPER_STATEMENT],
  [
    "the member register cannot be erased",
    `DELETE FROM public.member_register_entry WHERE id = 'no-such-entry'`,
  ],
  [
    "the audit log cannot be rewritten",
    `UPDATE public.audit_log_entry SET "action" = 'DATA_EXPORTED' WHERE id = 'no-such-entry'`,
  ],
  [
    "the audit log cannot be erased",
    `DELETE FROM public.audit_log_entry WHERE id = 'no-such-entry'`,
  ],
  [
    "a transfer cannot be deleted",
    `DELETE FROM public.transfer WHERE id = 'no-such-transfer'`,
  ],
  [
    "a lien note cannot be deleted",
    `DELETE FROM public.lien_note WHERE id = 'no-such-lien'`,
  ],
  [
    "a termination cannot be rewritten",
    `UPDATE public.termination SET "reference" = 'Tampered' WHERE id = 'no-such-termination'`,
  ],
  [
    "a termination cannot be deleted",
    `DELETE FROM public.termination WHERE id = 'no-such-termination'`,
  ],
  // A reversal records that a transfer was undone, and like a termination has
  // no later state to reach, so it keeps neither UPDATE nor DELETE.
  [
    "a transfer reversal cannot be rewritten",
    `UPDATE public.transfer_reversal SET "reference" = 'Tampered' WHERE id = 'no-such-reversal'`,
  ],
  [
    "a transfer reversal cannot be deleted",
    `DELETE FROM public.transfer_reversal WHERE id = 'no-such-reversal'`,
  ],
  // The obligation ledger takes termination's reading rather than transfer's: a
  // row states a statutory deadline, and neither the event it reports nor the
  // day the statute counts from can change, so it keeps neither UPDATE nor
  // DELETE.
  [
    "a reporting obligation cannot be rewritten",
    `UPDATE public.register_report_obligation SET "dueOn" = '2030-01-01' WHERE id = 'no-such-obligation'`,
  ],
  [
    "a reporting obligation cannot be deleted",
    `DELETE FROM public.register_report_obligation WHERE id = 'no-such-obligation'`,
  ],
];

/**
 * The statutory tables the application must still be able to read and append
 * to, because a register it cannot print or record an event in is no use.
 */
const PERMITTED_READS: string[] = [
  "SELECT count(*) FROM public.member_register_entry",
  "SELECT count(*) FROM public.transfer",
  "SELECT count(*) FROM public.lien_note",
  "SELECT count(*) FROM public.termination",
  "SELECT count(*) FROM public.transfer_reversal",
  "SELECT count(*) FROM public.register_report_obligation",
];

/** TRUNCATE is its own privilege and is granted on no table at all. */
const STATUTORY_TABLES = [
  "member_register_entry",
  "audit_log_entry",
  "transfer",
  "lien_note",
  "termination",
  "transfer_reversal",
  "register_report_obligation",
];

test("the application's role creates a queue and enqueues a job", async () => {
  test.setTimeout(60_000);

  // The application's own configuration: its connection, its schema,
  // migration off, because the schema is the owner's to install, and its pool
  // of two. The role may hold only the application's connections and three
  // more, and the application is running beside this test.
  const boss = new PgBoss({
    connectionString: stack.runtimeDatabaseUrl,
    schema: "pgboss",
    migrate: false,
    max: 2,
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

test("the application's role creates nothing, in either schema", async () => {
  // The queue above needed no CREATE: an ordinary queue is a row. So the
  // application owns nothing anywhere - a table it created would be its own,
  // beyond every revoke in the hardening script, and one the owner's job
  // schema install would then work on at every deploy.
  expect(
    await sqlStateOf(`CREATE TABLE pgboss.${SCRATCH_TABLE} (id int)`),
    "openbrf_app may not create objects in the job schema",
  ).toBe(PERMISSION_DENIED);

  // Migrations stay the owner's, so the application cannot reshape the schema
  // the statutory tables live in, nor disable the triggers that guard them.
  expect(
    await sqlStateOf(`CREATE TABLE public.${SCRATCH_TABLE} (id int)`),
    "openbrf_app may not create objects in the application schema",
  ).toBe(PERMISSION_DENIED);
});

test("nor write the record of which migrations have run", async () => {
  // The owner applies whatever the migration history says is missing, and the
  // job schema install whatever pgboss.version says is behind. A row the
  // application could write in either would decide what the next deploy does.
  // Every WHERE matches nothing: the refusal is on the privilege.
  for (const [what, statement] of [
    [
      "the migration history cannot be rewritten",
      `UPDATE public._prisma_migrations SET finished_at = NULL WHERE id = 'no-such-migration'`,
    ],
    [
      "a migration cannot be recorded as applied",
      `INSERT INTO public._prisma_migrations (id, checksum, migration_name, started_at, finished_at) VALUES ('e2e-${suffix}', 'e2e', 'e2e_${suffix}', now(), now())`,
    ],
    [
      "the migration history cannot be erased",
      `DELETE FROM public._prisma_migrations WHERE id = 'no-such-migration'`,
    ],
    [
      "the job schema's version cannot be changed",
      `UPDATE pgboss.version SET version = version WHERE false`,
    ],
    [
      "the job schema's version cannot be erased",
      `DELETE FROM pgboss.version WHERE false`,
    ],
  ] as const) {
    expect(await sqlStateOf(statement), what).toBe(PERMISSION_DENIED);
  }

  // pg-boss reads its version at start, so reading stays, and its maintenance
  // stamps the times it last ran on the same row, so those stay writable.
  expect(
    await sqlStateOf("SELECT version FROM pgboss.version"),
    "the job schema's version can still be read",
  ).toBeUndefined();
  expect(
    await sqlStateOf("UPDATE pgboss.version SET cron_on = cron_on WHERE false"),
    "the job queue's maintenance stamps can still be written",
  ).toBeUndefined();
});

test("nor queue an index build for the owner's job schema install to run", async () => {
  // pg-boss's runner executes each row of pgboss.bam as written, and only in
  // the owner's install. The application runs with migration off, so it has
  // no build to queue, and reading their state is all it may do.
  for (const [what, statement] of [
    [
      "an index build cannot be queued",
      `INSERT INTO pgboss.bam (name, version, status, table_name, command) VALUES ('e2e_${suffix}', 0, 'pending', 'job_common', 'SELECT 1')`,
    ],
    [
      "a queued index build cannot be rewritten",
      `UPDATE pgboss.bam SET command = 'SELECT 1' WHERE false`,
    ],
    ["an index build cannot be erased", `DELETE FROM pgboss.bam WHERE false`],
  ] as const) {
    expect(await sqlStateOf(statement), what).toBe(PERMISSION_DENIED);
  }
  expect(
    await sqlStateOf("SELECT count(*) FROM pgboss.bam"),
    "the index builds can still be read",
  ).toBeUndefined();
});

test("the application's role cannot write a partitioned queue or one with a job table of its own", async () => {
  // A queue's job table name is spliced into the SQL pg-boss runs as the owner
  // for a partitioned queue. The application declares its queues at runtime,
  // so it keeps writing queue rows, and a trigger the owner installed refuses
  // one the owner's migration would turn into SQL. The check below it is what
  // stops the install for a row already there.
  const queue = `runtime-role-rewritten-${suffix}`;
  await asRuntimeRole((client) =>
    client.query(
      `SELECT pgboss.create_queue($1, '{"policy": "standard"}'::jsonb)`,
      [queue],
    ),
  );
  try {
    const refusedRows = [
      [
        "a queue cannot be given a job table of its own",
        `UPDATE pgboss.queue SET table_name = 'job_e2e' WHERE name = '${queue}'`,
      ],
      [
        "a queue cannot be made a partitioned one",
        `UPDATE pgboss.queue SET partition = true WHERE name = '${queue}'`,
      ],
      [
        "a partitioned queue cannot be declared",
        `SELECT pgboss.create_queue('${queue}-partitioned', '{"policy": "standard", "partition": true}'::jsonb)`,
      ],
      [
        "a queue row with a job table of its own cannot be inserted",
        `INSERT INTO pgboss.queue (name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, retention_seconds, deletion_seconds, partition, table_name) VALUES ('${queue}-inserted', 'standard', 0, 0, false, 900, 900, 900, false, 'job_e2e')`,
      ],
    ] as const;
    for (const [what, statement] of refusedRows) {
      expect(await sqlStateOf(statement), what).toBe(CHECK_VIOLATION);
    }
    expect(
      await asRuntimeRole(async (client) => {
        const result = await client.query(
          `SELECT table_name, partition FROM pgboss.queue WHERE name = $1`,
          [queue],
        );
        return result.rows;
      }),
      "the queue is unchanged",
    ).toEqual([{ table_name: "job_common", partition: false }]);

    // Nor can the application take the trigger away: dropping it and switching
    // it off both need the privileges of the table's owner. Asked of the role
    // rather than tried for switching it off, which scripts/
    // check-statutory-guards.mjs refuses anywhere outside its allowlist.
    expect(
      await sqlStateOf("DROP TRIGGER refuse_own_job_table ON pgboss.queue"),
      "the trigger cannot be dropped",
    ).toBe(PERMISSION_DENIED);
    expect(
      await asRuntimeRole(async (client) => {
        const result = await client.query(
          `SELECT pg_has_role(current_user, relowner, 'USAGE') AS owner
           FROM pg_class WHERE oid = 'pgboss.queue'::regclass`,
        );
        return result.rows;
      }),
      "the trigger cannot be switched off",
    ).toEqual([{ owner: false }]);
  } finally {
    await connectedAs(stack.databaseUrl, (client) =>
      client.query("DELETE FROM pgboss.queue WHERE name = $1", [queue]),
    );
  }
});

test("a queue already rewritten stops the owner's job schema install", async () => {
  test.setTimeout(120_000);

  // A row that got in before the trigger did is what the install's own check
  // stops for. Written here by the owner with the trigger dropped, which is
  // also how it stays out of reach of the application, and the install puts
  // the trigger back before it looks.
  const queue = `runtime-role-planted-${suffix}`;
  await asRuntimeRole((client) =>
    client.query(
      `SELECT pgboss.create_queue($1, '{"policy": "standard"}'::jsonb)`,
      [queue],
    ),
  );
  try {
    await connectedAs(stack.databaseUrl, async (client) => {
      await client.query("DROP TRIGGER refuse_own_job_table ON pgboss.queue");
      await client.query(
        "UPDATE pgboss.queue SET table_name = 'job_e2e' WHERE name = $1",
        [queue],
      );
    });

    const refused = runInAppContainer(
      ["node", "/app/apps/api/scripts/install-job-schema.mjs"],
      { DATABASE_URL: OWNER_URL_IN_NETWORK },
      60_000,
    );
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain("pgboss.queue holds 1 queue(s)");
    expect(
      await asRuntimeRole(async (client) => {
        const result = await client.query(
          `SELECT count(*)::int AS count FROM pg_trigger
           WHERE tgrelid = 'pgboss.queue'::regclass
             AND tgname = 'refuse_own_job_table' AND tgenabled = 'O'`,
        );
        return result.rows;
      }),
      "the refused install put the trigger back",
    ).toEqual([{ count: 1 }]);
  } finally {
    await connectedAs(stack.databaseUrl, (client) =>
      client.query("DELETE FROM pgboss.queue WHERE name = $1", [queue]),
    );
  }
});

test("a membership the superuser granted is refused by the hardening and revoked by the schema-owner service", async () => {
  test.setTimeout(180_000);

  // What an instance that migrated as the superuser can carry: a role granted
  // to openbrf_app, whose privileges no revoke on openbrf_app reaches. The
  // owner may not revoke a grant the superuser made, so the hardening must
  // name the service that can rather than stop on a permission error, and that
  // service's next run must leave the hardening able to run.
  const probeRole = `runtime_role_probe_${suffix}`;
  const harden = () =>
    runInAppContainer(
      ["node", "/app/docker/harden-runtime-role.mjs"],
      {
        DATABASE_URL: OWNER_URL_IN_NETWORK,
        RUNTIME_DB_PASSWORD: stack.runtimePassword,
      },
      60_000,
    );
  const memberships = () =>
    runAsSuperuser([
      "--tuples-only",
      "--no-align",
      "--command",
      `SELECT count(*) FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = 'openbrf_app'`,
    ]);

  const granted = runAsSuperuser([
    "--command",
    `CREATE ROLE ${probeRole} NOLOGIN; GRANT ${probeRole} TO openbrf_app`,
  ]);
  expect(granted.status, granted.output).toBe(0);
  try {
    const refused = harden();
    expect(refused.status, "the hardening refuses").toBe(1);
    expect(refused.output).toContain(
      `Role openbrf_app is a member of role ${probeRole}`,
    );
    expect(refused.output).toContain("The schema-owner service revokes");
    expect(refused.output.includes("permission denied")).toBe(false);

    const upgraded = runSchemaOwner();
    expect(upgraded.status, upgraded.output).toBe(0);
    expect(memberships().output.trim(), "no membership is left").toBe("0");

    const hardened = harden();
    expect(hardened.status, hardened.output).toBe(0);
  } finally {
    runAsSuperuser(["--command", `DROP ROLE IF EXISTS ${probeRole}`]);
  }
});

test("the schema-owner service refuses a runtime role that is a superuser", () => {
  test.setTimeout(180_000);

  // Further on the service gives the owner ADMIN OPTION on the runtime role
  // and revokes the runtime role's memberships, so pointed at the superuser it
  // must stop before it changes anything.
  const refused = runSchemaOwner({ RUNTIME_DB_ROLE: "openbrf" });
  expect(refused.status, refused.output).toBe(1);
  expect(refused.output).toContain(
    "RUNTIME_DB_ROLE names openbrf, which is a superuser",
  );

  const granted = runAsSuperuser([
    "--tuples-only",
    "--no-align",
    "--command",
    `SELECT count(*) FROM pg_auth_members m JOIN pg_roles granted ON granted.oid = m.roleid WHERE granted.rolname = 'openbrf'`,
  ]);
  expect(
    granted.output.trim(),
    "nobody was made a member of the superuser",
  ).toBe("0");
});

test("the schema-owner service refuses a runtime role another database grants CONNECT to", () => {
  test.setTimeout(180_000);

  // What a second instance on the same server looks like from this one: its
  // runtime role may connect to its own database. Further on the service gives
  // the owner ADMIN OPTION on the runtime role and revokes its memberships, so
  // pointed at that role it must stop before it changes either. A role of the
  // test's own, because the owner already holds ADMIN OPTION on openbrf_app.
  const otherRole = `runtime_role_other_${suffix}`;
  const otherDatabase = `runtime_role_other_${suffix}`;
  const lentRole = `runtime_role_lent_${suffix}`;

  const made = runAsSuperuser([
    "--command",
    `CREATE ROLE ${otherRole} LOGIN; CREATE ROLE ${lentRole} NOLOGIN; GRANT ${lentRole} TO ${otherRole}`,
    // CREATE DATABASE cannot share a transaction with anything else.
    "--command",
    `CREATE DATABASE ${otherDatabase}`,
    "--command",
    `GRANT CONNECT ON DATABASE ${otherDatabase} TO ${otherRole}`,
  ]);
  expect(made.status, made.output).toBe(0);
  try {
    const refused = runSchemaOwner({ RUNTIME_DB_ROLE: otherRole });
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain(`RUNTIME_DB_ROLE names ${otherRole}`);
    expect(refused.output).toContain("belongs to another instance");

    expect(
      superuserValue(
        `SELECT count(*) FROM pg_auth_members m JOIN pg_roles granted ON granted.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE granted.rolname = '${otherRole}' AND member.rolname = 'openbrf_owner'`,
      ),
      "the owner was given nothing on the other instance's role",
    ).toBe("0");
    expect(
      superuserValue(
        `SELECT count(*) FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = '${otherRole}'`,
      ),
      "the other instance's role keeps its membership",
    ).toBe("1");
  } finally {
    runAsSuperuser([
      "--command",
      `DROP DATABASE IF EXISTS ${otherDatabase}`,
      "--command",
      `DROP ROLE IF EXISTS ${otherRole}; DROP ROLE IF EXISTS ${lentRole}`,
    ]);
  }
});

test("the schema-owner service refuses to run as a role that is not the superuser", async () => {
  test.setTimeout(180_000);

  // What an instance on a shared server would do if its env file still named
  // its own owner in POSTGRES_USER, as it did before the schema owner existed.
  // Everything the service does needs a superuser, so it must stop before the
  // first change: here, before it sets the owner's password to a new one.
  const ownerState = () =>
    superuserValue(
      `SELECT r.rolsuper::text || ' ' || r.rolcreaterole::text || ' ' || pg_get_userbyid(d.datdba) FROM pg_roles r, pg_database d WHERE r.rolname = 'openbrf_owner' AND d.datname = 'openbrf'`,
    );
  const before = ownerState();

  const refused = runSchemaOwner({
    POSTGRES_USER: "openbrf_owner",
    POSTGRES_PASSWORD: stack.ownerPassword,
    OWNER_DB_PASSWORD: `not-the-owner-password-${suffix}`,
  });
  expect(refused.status, refused.output).toBe(1);
  expect(refused.output).toContain(
    "POSTGRES_USER names openbrf_owner, which is not one",
  );

  expect(ownerState(), "the owner and the database are as they were").toBe(
    before,
  );
  // The owner's password is the one it had: this connects with it.
  await asOwner("SELECT 1");
});

test("the schema-owner service hands the owner nothing the runtime role made", () => {
  test.setTimeout(180_000);

  // What an instance upgraded from an earlier release can carry: an object the
  // runtime role made in pgboss, where it could once create. The owner takes
  // over only what the superuser's migrations left, so the service must stop,
  // name the object, and leave it where it was.
  const probeFunction = `pgboss.runtime_role_probe_${suffix}()`;
  const ownerOfProbe = () =>
    runAsSuperuser([
      "--tuples-only",
      "--no-align",
      "--command",
      `SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = '${probeFunction}'::regprocedure`,
    ]).output.trim();

  const made = runAsSuperuser([
    "--command",
    `CREATE FUNCTION ${probeFunction} RETURNS integer LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION ${probeFunction} OWNER TO openbrf_app`,
  ]);
  expect(made.status, made.output).toBe(0);
  try {
    const refused = runSchemaOwner();
    expect(refused.status, "the service refuses").toBe(1);
    expect(refused.output).toContain(
      `function ${probeFunction}, owned by openbrf_app`,
    );
    expect(ownerOfProbe(), "the object stays the runtime role's").toBe(
      "openbrf_app",
    );
  } finally {
    runAsSuperuser(["--command", `DROP FUNCTION IF EXISTS ${probeFunction}`]);
  }

  const upgraded = runSchemaOwner();
  expect(upgraded.status, upgraded.output).toBe(0);
});

test("the schema-owner service uses the built-in functions whatever search_path the database sets", async () => {
  test.setTimeout(180_000);

  // The database is the owner's, so the owner can give it a search_path that
  // puts public first and make functions there. The service runs as the
  // superuser and means the built-in one by every name it uses, so a function
  // of the owner's that shares a name and arguments with one it calls must
  // never run in its place.
  const MARKER = `search_path probe ${suffix}`;

  await asOwner(
    `CREATE FUNCTION public.set_config(text, text, boolean) RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION '${MARKER}'; END$$`,
  );
  try {
    await asOwner(
      "ALTER DATABASE openbrf SET search_path = public, pg_catalog",
    );

    const upgraded = runSchemaOwner();
    expect(upgraded.status, upgraded.output).toBe(0);
    expect(upgraded.output.includes(MARKER), "the owner's function ran").toBe(
      false,
    );
  } finally {
    await asOwner("ALTER DATABASE openbrf RESET search_path");
    await asOwner(
      "DROP FUNCTION IF EXISTS public.set_config(text, text, boolean)",
    );
  }
});

test("the application's role still cannot rewrite the statutory archive", async () => {
  // Refused on the privilege rather than by the append-only trigger. Both
  // exist, and this is the one an owner could not switch off.
  for (const [what, statement] of REFUSED_STATEMENTS) {
    expect(await sqlStateOf(statement), what).toBe(PERMISSION_DENIED);
  }
});

test("nor truncate any of it, which no row-level trigger would catch", async () => {
  // A separate privilege in PostgreSQL, not implied by DELETE, so the blanket
  // grant never conferred it - and one statement would empty a table without
  // firing a single row trigger.
  for (const table of STATUTORY_TABLES) {
    expect(
      await sqlStateOf(`TRUNCATE TABLE public.${table}`),
      `${table} cannot be truncated by the application`,
    ).toBe(PERMISSION_DENIED);
  }
});

test("but still reads the statutory archive, because it has to be printable", async () => {
  // The other half of the same rule. A revoke that reached SELECT would leave
  // the association unable to produce a register the law requires it to be
  // able to produce, and this is what says the revokes above are narrow.
  for (const statement of PERMITTED_READS) {
    expect(await sqlStateOf(statement), statement).toBeUndefined();
  }
});

/**
 * Read inside the application's container, about every process in it.
 *
 * Every process, the container's init process included, and the probe itself:
 * a `docker compose exec` starts from the container's configured environment,
 * so the probe holding no owner credential is the evidence that the container
 * was never given one. The secrets to look for arrive on standard input, which
 * is the one way to hand them over without putting them in the probe's own
 * environment or arguments - either would make the probe the thing it finds.
 *
 * An environment the probe cannot read is reported rather than skipped: the
 * claim is about every process, and one that was not looked at is not evidence.
 * A refused read is retried first, because a process that is still being set
 * up is refused for a moment; one that exits meanwhile is simply gone.
 *
 * Every connection URL found in the server's environment is then used, from
 * inside the container, against the member register. Naming the variables
 * that must be gone would only prove the names are gone; using what is left
 * proves the credentials the server actually holds cannot rewrite the
 * register.
 *
 * Nothing but a verdict crosses back: no value from any environment is
 * printed, because the output of a failing suite ends up in a log.
 */
const CONTAINER_PROCESS_PROBE = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const secrets = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(secrets) || secrets.length === 0) throw new Error("no secrets to look for");
const needles = secrets.flatMap((secret) => [secret, encodeURIComponent(secret)]);

function environmentOf(pid) {
  return fs
    .readFileSync("/proc/" + pid + "/environ", "utf8")
    .split("\\0")
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)];
    });
}

${ENVIRONMENT_READER_SOURCE}

// A refused read is retried for about a second before the process counts as
// unreadable; see src/environment-reader.ts.
const readEnvironment = makeEnvironmentReader({
  read: environmentOf,
  exists: (pid) => fs.existsSync("/proc/" + pid),
  sleep: (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
});

function argumentsOf(pid) {
  return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean);
}

const processes = [];
let server;
for (const entry of fs.readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(entry)) continue;
  const read = readEnvironment(entry);
  // A process that exited between the listing and the read has no
  // environment left to hold anything.
  if (read.gone) continue;
  if (read.held === undefined) {
    processes.push({ pid: Number(entry), readable: false, carriesOwnerSecret: false, ownerNames: [] });
    continue;
  }
  const held = read.held;
  const names = held.map(([name]) => name);
  processes.push({
    pid: Number(entry),
    readable: true,
    carriesOwnerSecret: held.some(([, value]) => needles.some((needle) => value.includes(needle))),
    ownerNames: names.filter((name) => ["POSTGRES_PASSWORD", "OWNER_DB_PASSWORD", "DATABASE_URL", "PGPASSWORD"].includes(name)),
  });
  try {
    const argv = argumentsOf(entry);
    const program = (argv[0] ?? "").split("/").pop();
    if (program === "node" && argv.includes("dist/main.js") && Number(entry) !== 1) {
      server = { pid: Number(entry), held };
    }
  } catch {
    // Gone between the two reads; it was not the server.
  }
}
if (server === undefined) throw new Error("no application process is running");

const connections = server.held.map(([, value]) => value).filter((value) => /^postgres(ql)?:\\/\\//.test(value));
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
    // The refusal of this statement on this table, and nothing looser: a
    // connection refused the database itself says "permission denied for
    // database", and never ran the UPDATE at all.
    return said.includes("permission denied for table member_register_entry") ? "permission denied" : "refused for another reason";
  }
});

process.stdout.write(JSON.stringify({
  self: process.pid,
  processes,
  serverNames: server.held.map(([name]) => name),
  refusals,
}));
`;

test("no process in the application's container holds an owner credential", () => {
  test.setTimeout(60_000);

  const { status, output } = runInAppContainer(
    ["node", "-e", CONTAINER_PROCESS_PROBE],
    {},
    60_000,
    // The superuser's password as well as the schema owner's: neither has any
    // business in this container.
    JSON.stringify([stack.ownerPassword, stack.superuserPassword]),
  );
  expect(status, `the probe ran: ${output}`).toBe(0);

  const seen = JSON.parse(output) as {
    self: number;
    processes: {
      pid: number;
      readable: boolean;
      carriesOwnerSecret: boolean;
      ownerNames: string[];
    }[];
    serverNames: string[];
    refusals: string[];
  };

  // The init process, the server and the probe itself were all looked at.
  const pids = seen.processes.map((process) => process.pid);
  expect(pids, "the container's init process was read").toContain(1);
  expect(pids, "the probe read its own environment").toContain(seen.self);
  expect(pids.length).toBeGreaterThanOrEqual(3);

  for (const process of seen.processes) {
    expect(process.readable, `pid ${process.pid} could be read`).toBe(true);
    // The owner runs migrations, installs the job schema and applies the role
    // hardening, all in the migrate service. A table's owner can ALTER TABLE
    // ... DISABLE TRIGGER, so its credentials anywhere in this container would
    // put the append-only member register and the audit log back within reach
    // of an application-path compromise.
    expect(
      process.ownerNames,
      `pid ${process.pid} holds no owner credential by name`,
    ).toEqual([]);
    expect(
      process.carriesOwnerSecret,
      `no variable pid ${process.pid} holds carries an owner's password`,
    ).toBe(false);
  }

  expect(
    seen.serverNames,
    "the application connects as openbrf_app and nothing else",
  ).toContain("DATABASE_URL_RUNTIME");

  // And what the server does hold cannot rewrite the register.
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

/**
 * Whether the user the application runs as can change the code under /app.
 *
 * Two questions, because either answer alone could be the other's accident.
 * The ownership walk asks the image: nothing under /app may belong to that
 * user or be writable by everyone, whatever the container mounts. The append
 * asks the running container, which the compose file also mounts read-only,
 * against the one file the owner's deploy step reads SQL from.
 */
const CODE_WRITE_PROBE = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

// The status is not the answer: find exits non-zero on a directory it may not
// read, and a directory this user may not read is not one it can write into.
// What it prints is the answer.
const writable = spawnSync(
  "find",
  ["/app", "(", "-user", String(process.getuid()), "-o", "-perm", "-0002", ")", "-not", "-type", "l", "-print", "-quit"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
).stdout.trim();

const appended = [];
for (const target of [
  "/app/apps/api/prisma/sql/harden-runtime-role.sql",
  "/app/apps/api/dist/main.js",
  "/app/docker/with-owner-url.mjs",
]) {
  try {
    fs.appendFileSync(target, "");
    appended.push(target);
  } catch {
    // Refused, which is the point.
  }
}
let created = false;
try {
  fs.writeFileSync("/app/apps/api/e2e-probe.js", "");
  created = true;
} catch {}

process.stdout.write(JSON.stringify({ uid: process.getuid(), writable, appended, created }));
`;

test("the application's user cannot change the code under /app", () => {
  test.setTimeout(120_000);

  const { status, output } = runInAppContainer(
    ["node", "-e", CODE_WRITE_PROBE],
    {},
    120_000,
  );
  expect(status, `the probe ran: ${output}`).toBe(0);

  const seen = JSON.parse(output) as {
    uid: number;
    writable: string;
    appended: string[];
    created: boolean;
  };
  expect(seen.uid, "the probe runs as the application's user").not.toBe(0);
  expect(
    seen.writable,
    "nothing under /app belongs to that user or is writable by everyone",
  ).toBe("");
  expect(seen.appended, "no file the deploy runs can be appended to").toEqual(
    [],
  );
  expect(seen.created, "no file can be added beside the code").toBe(false);
});

test("the application refuses to serve when connected as the schema owner", () => {
  test.setTimeout(120_000);

  // What an operator managing the role themselves gets wrong: the owner's URL
  // in DATABASE_URL_RUNTIME. The server is started as the image starts it, on a
  // port of its own so it cannot take the running instance's, and must stop
  // before it listens.
  const { status, output } = runInAppContainer(
    ["node", "dist/main.js"],
    { DATABASE_URL_RUNTIME: OWNER_URL_IN_NETWORK, PORT: "3999" },
    120_000,
  );

  expect(status, `the server stops: ${output}`).not.toBe(0);
  expect(output).toContain("not the constrained runtime role");
  expect(output).toContain("openbrf_owner");
  expect(
    output.includes(stack.ownerPassword) ||
      output.includes(encodeURIComponent(stack.ownerPassword)),
    "the refusal does not echo the connection",
  ).toBe(false);
});

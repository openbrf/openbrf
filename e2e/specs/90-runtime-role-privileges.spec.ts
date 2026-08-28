import { expect, test } from "@playwright/test";
import pg from "pg";
import { PgBoss } from "pg-boss";

import { stack } from "../src/stack";

/**
 * What the application's own database role can and cannot do.
 *
 * Not one of the numbered exit criteria: it is the evidence behind the two
 * roles the deployment uses. `prisma/sql/harden-runtime-role.sql` constrains
 * openbrf_app so a bug in the application cannot rewrite the member register or
 * the audit log, and it grants CREATE on the pgboss schema so a queue can be
 * declared at runtime. Both halves are checked here, against the role the
 * entrypoint really created, because a grant nothing exercises is one that
 * stops working quietly.
 *
 * Everything below connects as openbrf_app itself rather than through the
 * application, so a failure names the privilege rather than a screen.
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
  // Refused on the privilege, before any row is looked at, which is why the
  // WHERE matches nothing: this is the grant, not the append-only trigger. Both
  // exist, and this is the one an owner could not switch off.
  expect(
    await sqlStateOf(
      `UPDATE public.member_register_entry SET "recordedLastName" = 'Tampered' WHERE id = 'no-such-entry'`,
    ),
    "the member register is insert and read only for the application",
  ).toBe(PERMISSION_DENIED);

  expect(
    await sqlStateOf(
      `DELETE FROM public.audit_log_entry WHERE id = 'no-such-entry'`,
    ),
    "the audit log is evidence, and the application cannot erase it",
  ).toBe(PERMISSION_DENIED);
});

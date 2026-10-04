import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { ARCHIVE_REVOKES, assertConstrainedRuntimeRole } from "./runtime-role";

/**
 * A production start refuses a connection that is not the constrained role.
 *
 * DATABASE_URL_RUNTIME is written by hand by an operator who manages the role
 * themselves, and nothing about the variable says which role it names. These
 * suites connect as the schema owner, which is exactly the connection the
 * application must refuse, and as a role of their own holding what the
 * hardening script leaves the runtime role, which it must accept - and then
 * hand that role, one at a time, each privilege the script takes away, which
 * it must refuse again.
 */

const env = loadEnvForIntegrationTests();

const suffix = process.hrtime.bigint().toString(36);
const CONSTRAINED_ROLE = `openbrf_runtime_probe_${suffix.replace(/[^a-z0-9]/gi, "")}`;
const CONSTRAINED_PASSWORD = randomBytes(16).toString("hex");

let owner: PrismaClient;

/** Whether the suite made the job schema's version table, to drop it again. */
let madeJobSchema = false;

function production(url: string) {
  return { ...env, NODE_ENV: "production" as const, DATABASE_URL_RUNTIME: url };
}

function asRole(role: string, password: string): string {
  const url = new URL(env.DATABASE_URL);
  url.username = role;
  url.password = password;
  return url.href;
}

beforeAll(async () => {
  owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  // What harden-runtime-role.sql leaves the application on the two tables the
  // check reads: SELECT and INSERT, nothing that rewrites, nothing owned.
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${CONSTRAINED_ROLE} LOGIN PASSWORD '${CONSTRAINED_PASSWORD}'`,
  );
  await owner.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA public TO ${CONSTRAINED_ROLE}`,
  );
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT ON ${ARCHIVE_REVOKES.map(({ table }) => `public.${table}`).join(", ")} TO ${CONSTRAINED_ROLE}`,
  );

  // The job schema is installed at deploy time, not by the migrations the
  // suite's database is built from. Its version table is made here when it is
  // missing, with the version and one of the maintenance stamps beside it.
  const [jobSchema] = await owner.$queryRawUnsafe<{ present: boolean }[]>(
    "SELECT to_regclass('pgboss.version') IS NOT NULL AS present",
  );
  if (jobSchema?.present !== true) {
    madeJobSchema = true;
    await owner.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS pgboss");
    await owner.$executeRawUnsafe(
      "CREATE TABLE pgboss.version (version integer, cron_on timestamptz)",
    );
  }
  await owner.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA pgboss TO ${CONSTRAINED_ROLE}`,
  );
  await owner.$executeRawUnsafe(
    `GRANT SELECT, UPDATE (cron_on) ON pgboss.version TO ${CONSTRAINED_ROLE}`,
  );
});

afterAll(async () => {
  await owner.$executeRawUnsafe(`DROP OWNED BY ${CONSTRAINED_ROLE}`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${CONSTRAINED_ROLE}`);
  if (madeJobSchema) {
    await owner.$executeRawUnsafe("DROP TABLE pgboss.version");
  }
  await owner.$disconnect();
});

describe("a production start", () => {
  it("refuses to serve when connected as the schema owner", async () => {
    await expect(
      assertConstrainedRuntimeRole(production(env.DATABASE_URL)),
    ).rejects.toThrow(/not the constrained runtime role/);
  });

  it("names what it found, and nothing from the connection", async () => {
    const failure = await assertConstrainedRuntimeRole(
      production(env.DATABASE_URL),
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(
      /can rewrite or delete statutory records in member_register_entry, audit_log_entry/,
    );
    // The role's name is what an operator needs to read; the URL it came in
    // is not, and would carry the password.
    expect(failure?.message.includes("postgresql://")).toBe(false);
    expect(failure?.message.includes(env.DATABASE_URL)).toBe(false);
  });

  it("serves when connected as a role that owns nothing and cannot rewrite the archive", async () => {
    await expect(
      assertConstrainedRuntimeRole(
        production(asRole(CONSTRAINED_ROLE, CONSTRAINED_PASSWORD)),
      ),
    ).resolves.toBeUndefined();
  });

  /**
   * Grants one privilege, expects the start to refuse with the reason given,
   * and takes the privilege back whatever happened.
   */
  async function refusedWith(
    grant: string,
    revoke: string,
    reason: RegExp,
  ): Promise<void> {
    await owner.$executeRawUnsafe(grant);
    try {
      await expect(
        assertConstrainedRuntimeRole(
          production(asRole(CONSTRAINED_ROLE, CONSTRAINED_PASSWORD)),
        ),
      ).rejects.toThrow(reason);
    } finally {
      await owner.$executeRawUnsafe(revoke);
    }
  }

  it("refuses a role that can write the migration history", async () => {
    await refusedWith(
      `GRANT UPDATE ON public._prisma_migrations TO ${CONSTRAINED_ROLE}`,
      `REVOKE UPDATE ON public._prisma_migrations FROM ${CONSTRAINED_ROLE}`,
      /can write the migration history/,
    );
  });

  it.each(
    ARCHIVE_REVOKES.flatMap(({ table, privileges }) =>
      privileges.map((privilege) => ({ table, privilege })),
    ),
  )(
    "refuses a role holding $privilege on $table",
    async ({ table, privilege }) => {
      await refusedWith(
        `GRANT ${privilege} ON public.${table} TO ${CONSTRAINED_ROLE}`,
        `REVOKE ${privilege} ON public.${table} FROM ${CONSTRAINED_ROLE}`,
        // The only problem, so the table's name is the whole list.
        new RegExp(`can rewrite or delete statutory records in ${table}\\.`),
      );
    },
  );

  it("still serves a role that can correct a transfer and release a lien", async () => {
    // UPDATE stays on these two on purpose, so it is no reason to refuse.
    await owner.$executeRawUnsafe(
      `GRANT UPDATE ON public.transfer, public.lien_note TO ${CONSTRAINED_ROLE}`,
    );
    try {
      await expect(
        assertConstrainedRuntimeRole(
          production(asRole(CONSTRAINED_ROLE, CONSTRAINED_PASSWORD)),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await owner.$executeRawUnsafe(
        `REVOKE UPDATE ON public.transfer, public.lien_note FROM ${CONSTRAINED_ROLE}`,
      );
    }
  });

  it.each(["public", "pgboss"])(
    "refuses a role that can create objects in %s",
    async (schema) => {
      await refusedWith(
        `GRANT CREATE ON SCHEMA ${schema} TO ${CONSTRAINED_ROLE}`,
        `REVOKE CREATE ON SCHEMA ${schema} FROM ${CONSTRAINED_ROLE}`,
        /can create objects in the public or the pgboss schema/,
      );
    },
  );

  it.each(["INSERT", "DELETE", "TRUNCATE", "UPDATE"])(
    "refuses a role holding %s on the job schema's version",
    async (privilege) => {
      await refusedWith(
        `GRANT ${privilege} ON pgboss.version TO ${CONSTRAINED_ROLE}`,
        `REVOKE ${privilege} ON pgboss.version FROM ${CONSTRAINED_ROLE}`,
        /can write the job schema's version/,
      );
    },
  );

  it.each([
    {
      kind: "a function in public",
      create: `CREATE FUNCTION public.${CONSTRAINED_ROLE}_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      object: `FUNCTION public.${CONSTRAINED_ROLE}_fn()`,
    },
    {
      kind: "a function in pgboss",
      create: `CREATE FUNCTION pgboss.${CONSTRAINED_ROLE}_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      object: `FUNCTION pgboss.${CONSTRAINED_ROLE}_fn()`,
    },
    {
      kind: "an enum in public",
      create: `CREATE TYPE public.${CONSTRAINED_ROLE}_enum AS ENUM ('a')`,
      object: `TYPE public.${CONSTRAINED_ROLE}_enum`,
    },
    {
      kind: "a domain in pgboss",
      create: `CREATE DOMAIN pgboss.${CONSTRAINED_ROLE}_domain AS integer`,
      object: `DOMAIN pgboss.${CONSTRAINED_ROLE}_domain`,
    },
  ])("refuses a role that owns $kind", async ({ create, object }) => {
    // Owning a function is enough to drop it, and with CASCADE every trigger
    // that runs it, whatever the role may do to the tables themselves.
    await owner.$executeRawUnsafe(create);
    try {
      await refusedWith(
        `ALTER ${object} OWNER TO ${CONSTRAINED_ROLE}`,
        `ALTER ${object} OWNER TO CURRENT_USER`,
        /owns functions or types in the application's schemas/,
      );
    } finally {
      await owner.$executeRawUnsafe(`DROP ${object}`);
    }
  });

  it("refuses a role that is a member of another role", async () => {
    // pg_execute_server_program lends COPY ... TO PROGRAM, which no revoke on
    // the runtime role itself would reach.
    await refusedWith(
      `GRANT pg_execute_server_program TO ${CONSTRAINED_ROLE}`,
      `REVOKE pg_execute_server_program FROM ${CONSTRAINED_ROLE}`,
      /is a member of pg_execute_server_program/,
    );
  });

  it("refuses a role granted UPDATE on the version column alone", async () => {
    // A column grant is a privilege of its own beside the table's; asking only
    // of the table would miss it.
    await refusedWith(
      `GRANT UPDATE (version) ON pgboss.version TO ${CONSTRAINED_ROLE}`,
      `REVOKE UPDATE (version) ON pgboss.version FROM ${CONSTRAINED_ROLE}`,
      /can write the job schema's version/,
    );
  });

  it.each(["INSERT (finished_at)", "UPDATE (finished_at)"])(
    "refuses a role granted %s on the migration history",
    async (privilege) => {
      await refusedWith(
        `GRANT ${privilege} ON public._prisma_migrations TO ${CONSTRAINED_ROLE}`,
        `REVOKE ${privilege} ON public._prisma_migrations FROM ${CONSTRAINED_ROLE}`,
        /can write the migration history/,
      );
    },
  );

  it.each(
    ARCHIVE_REVOKES.filter(({ privileges }) =>
      privileges.includes("UPDATE"),
    ).map(({ table }) => table),
  )("refuses a role granted UPDATE on one column of %s", async (table) => {
    await refusedWith(
      `GRANT UPDATE (id) ON public.${table} TO ${CONSTRAINED_ROLE}`,
      `REVOKE UPDATE (id) ON public.${table} FROM ${CONSTRAINED_ROLE}`,
      new RegExp(`can rewrite or delete statutory records in ${table}\\.`),
    );
  });

  it("still serves a role granted UPDATE on one column of a transfer", async () => {
    // A transfer keeps UPDATE on purpose, on a column as on the table.
    await owner.$executeRawUnsafe(
      `GRANT UPDATE (id) ON public.transfer TO ${CONSTRAINED_ROLE}`,
    );
    try {
      await expect(
        assertConstrainedRuntimeRole(
          production(asRole(CONSTRAINED_ROLE, CONSTRAINED_PASSWORD)),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await owner.$executeRawUnsafe(
        `REVOKE UPDATE (id) ON public.transfer FROM ${CONSTRAINED_ROLE}`,
      );
    }
  });
});

describe("outside production", () => {
  it("leaves the owner connection a development instance runs on alone", async () => {
    await expect(
      assertConstrainedRuntimeRole({
        ...env,
        DATABASE_URL_RUNTIME: env.DATABASE_URL,
      }),
    ).resolves.toBeUndefined();
  });
});

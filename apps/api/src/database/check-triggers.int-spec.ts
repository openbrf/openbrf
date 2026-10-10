import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { scratchDatabases, withClient } from "../testing/scratch-databases";

/**
 * scripts/check-triggers.mjs, which the deploy runs as the schema owner before
 * the migrations (docker/entrypoint.sh, step 4), and which the job schema
 * install runs again before pg-boss migrates.
 *
 * A trigger fires for whoever writes its table, and the migrations write as
 * the owner. CREATE OR REPLACE TRIGGER asks only for the TRIGGER privilege on
 * the table, so a role that held it could have replaced a guard, or planted a
 * trigger of its own for the owner to run, and the grant that let it is gone
 * once the hardening has revoked it. The cases below plant what such a role
 * would have left, as the suite's owner connection and with no grant left
 * behind, and expect the check to stop the deploy on it.
 *
 * The same goes for a function or operator in public or pgboss: a name a
 * migration calls can resolve to one, which then runs as the owner, so the
 * check also stops on one of another role's, and on a role that owns either
 * schema or holds CREATE there and so could make one.
 *
 * The cases that change a trigger, plant a function or operator, or grant
 * CREATE do so on the worker's database and put it back, so the suites after
 * them meet what the migrations created.
 */

const env = loadEnvForIntegrationTests();

const script = join(process.cwd(), "scripts", "check-triggers.mjs");

const suffix = process.hrtime
  .bigint()
  .toString(36)
  .replace(/[^a-z0-9]/gi, "");
/**
 * A role other than the owner, standing for one that held TRIGGER, or CREATE
 * in public or pgboss.
 */
const PROBE_ROLE = `openbrf_trigger_check_${suffix}`;
/**
 * A schema of the suite's own, so that the function below is not one of
 * another role's in public, which the check refuses in its own right.
 */
const PROBE_SCHEMA = `openbrf_trigger_check_${suffix}`;
/** A function of that role's, for a trigger to call. */
const PROBE_FUNCTION = `${PROBE_SCHEMA}.openbrf_trigger_check_${suffix}`;

interface Trigger {
  table: string;
  definition: string;
  ownersFunction: boolean;
}

interface TriggerCheck {
  EXPECTED_TRIGGERS: string[];
  currentTriggers(db: {
    executeSql(text: string): Promise<unknown>;
  }): Promise<Trigger[]>;
}

/** Runs one statement as the owner, on the worker's database. */
async function asOwner(statement: string): Promise<void> {
  await withClient(env.DATABASE_URL, (client) => client.query(statement));
}

/** Runs the check the way the migrate service does, and says how it went. */
function check(databaseUrl = env.DATABASE_URL): {
  status: number | null;
  output: string;
} {
  const result = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_URL_RUNTIME: undefined,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Empty databases, as a first deploy meets them before any migration has run.
 * Dropped again once the suite is done.
 */
const scratch = scratchDatabases();

/**
 * The trigger the migrations or the install created, as a statement that puts
 * it back.
 */
function restore(definition: string): string {
  return definition.replace(/^CREATE TRIGGER /, "CREATE OR REPLACE TRIGGER ");
}

let triggers: TriggerCheck;

beforeAll(async () => {
  triggers = (await import(pathToFileURL(script).href)) as TriggerCheck;
  await asOwner(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
  await asOwner(`CREATE SCHEMA ${PROBE_SCHEMA}`);
  await asOwner(
    `CREATE FUNCTION ${PROBE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
  );
  await asOwner(`ALTER FUNCTION ${PROBE_FUNCTION}() OWNER TO ${PROBE_ROLE}`);
});

afterAll(async () => {
  // The databases first: a default privilege left in one would keep the role.
  await scratch.dropAll();
  await asOwner(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`);
  await asOwner(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
});

describe("the trigger check before the migrations", () => {
  it("knows every trigger the migrations and the job schema install create, and no other", async () => {
    // A migration that adds a trigger without its line in the list would
    // stop the next deploy of every instance, and a line nothing creates is a
    // definition the check would wave through. Both show up here.
    const current = await withClient(env.DATABASE_URL, (client) =>
      triggers.currentTriggers({ executeSql: (text) => client.query(text) }),
    );

    expect(current.map((trigger) => trigger.definition).sort()).toEqual(
      [...triggers.EXPECTED_TRIGGERS].sort(),
    );
    expect(
      current.filter((trigger) => !trigger.ownersFunction),
      "triggers calling a function their table's owner does not own",
    ).toEqual([]);
  });

  it("passes the database the migrations and the job schema install built", () => {
    const passed = check();
    expect(passed.status, passed.output).toBe(0);
  });

  it("passes an empty database, as a first deploy meets it", async () => {
    const databaseUrl = await scratch.create("triggers_empty");
    // public belongs to pg_database_owner on PostgreSQL 15 and later, which
    // stands here for the role the check runs as, the database's owner.
    const owner = await withClient(databaseUrl, async (client) => {
      const result = await client.query<{ owner: string }>(
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'public'",
      );
      return result.rows[0]?.owner;
    });
    expect(owner).toBe("pg_database_owner");

    const passed = check(databaseUrl);
    expect(passed.status, passed.output).toBe(0);
  });

  it.each([
    {
      where: "in every schema",
      grant: "ALTER DEFAULT PRIVILEGES GRANT TRIGGER ON TABLES",
      reported: "every schema",
    },
    {
      where: "in public",
      grant:
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRIGGER ON TABLES",
      reported: "public",
    },
  ])(
    "stops a first deploy whose owner gives another role TRIGGER by default $where",
    async ({ grant, reported }) => {
      // Every table the migrations create takes this grant as it is created,
      // so the role holds TRIGGER on the statutory tables from the moment
      // they exist. No table holds it yet, so only the defaults show it.
      const databaseUrl = await scratch.create("triggers_defaults");
      await withClient(databaseUrl, (client) =>
        client.query(`${grant} TO ${PROBE_ROLE}`),
      );
      try {
        const refused = check(databaseUrl);
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain(
          `${PROBE_ROLE} is given TRIGGER by default on the tables the ` +
            `schema owner creates in ${reported}.`,
        );
        expect(refused.output).toContain("So the deploy stops here.");
      } finally {
        await withClient(databaseUrl, (client) =>
          client.query(
            `${grant.replace("GRANT", "REVOKE")} FROM ${PROBE_ROLE}`,
          ),
        );
      }
    },
    60_000,
  );

  it.each([
    {
      what: "the trigger on pgboss.queue, made to fire on nothing it guards",
      guard: "refuse_own_job_table",
      replacement:
        "CREATE OR REPLACE TRIGGER refuse_own_job_table BEFORE DELETE ON pgboss.queue FOR EACH ROW EXECUTE FUNCTION pgboss.refuse_own_job_table()",
    },
    {
      what: "a check on a register table, given a WHEN clause that never holds",
      guard: "transfer_states_what_it_is",
      replacement:
        "CREATE OR REPLACE TRIGGER transfer_states_what_it_is BEFORE INSERT OR UPDATE ON public.transfer FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.openbrf_check_transfer_record()",
    },
  ])(
    "stops on $what, with no grant left to show who did it",
    async ({ guard, replacement }) => {
      const original = triggers.EXPECTED_TRIGGERS.find((definition) =>
        definition.startsWith(`CREATE TRIGGER ${guard} `),
      );
      expect(original, "the trigger is one the list names").toBeDefined();
      await asOwner(replacement);
      try {
        const refused = check();
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain(
          "has a trigger that is not one the migrations or the job schema " +
            `install create: ${replacement.replace("CREATE OR REPLACE", "CREATE")}`,
        );
        expect(refused.output).not.toContain(" holds TRIGGER on ");
        expect(refused.output).toContain("So the deploy stops here.");
      } finally {
        await asOwner(restore(original ?? ""));
      }
    },
    60_000,
  );

  it("stops on a trigger of another role's on the table the migrations write first", async () => {
    // prisma migrate deploy records every migration in _prisma_migrations as
    // the owner, so a trigger there runs its function with the owner's
    // privileges on every deploy that applies one.
    await asOwner(
      `CREATE TRIGGER openbrf_trigger_check_${suffix}
         BEFORE INSERT ON public._prisma_migrations
         FOR EACH ROW EXECUTE FUNCTION ${PROBE_FUNCTION}()`,
    );
    try {
      const refused = check();
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        "public._prisma_migrations has a trigger that is not one the " +
          "migrations or the job schema install create: CREATE TRIGGER " +
          `openbrf_trigger_check_${suffix} BEFORE INSERT ON ` +
          "public._prisma_migrations",
      );
    } finally {
      await asOwner(
        `DROP TRIGGER openbrf_trigger_check_${suffix} ON public._prisma_migrations`,
      );
    }
  }, 60_000);

  it("stops on a trigger as created whose function its table's owner no longer owns", async () => {
    // The trigger reads as the install wrote it, but whoever owns the
    // function can rewrite what it does.
    await asOwner(
      `ALTER FUNCTION pgboss.refuse_own_job_table() OWNER TO ${PROBE_ROLE}`,
    );
    try {
      const refused = check();
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        "pgboss.queue has a trigger calling a function that the table's " +
          "owner does not own: CREATE TRIGGER refuse_own_job_table",
      );
    } finally {
      await asOwner(
        "ALTER FUNCTION pgboss.refuse_own_job_table() OWNER TO CURRENT_USER",
      );
    }
  }, 60_000);

  it("stops while a role other than the owner holds TRIGGER on a table", async () => {
    await asOwner(
      `GRANT TRIGGER ON public._prisma_migrations TO ${PROBE_ROLE}`,
    );
    try {
      const refused = check();
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `${PROBE_ROLE} holds TRIGGER on public._prisma_migrations.`,
      );
      expect(refused.output).toContain("So the deploy stops here.");
    } finally {
      await asOwner(
        `REVOKE TRIGGER ON public._prisma_migrations FROM ${PROBE_ROLE}`,
      );
    }
  }, 60_000);

  it.each([
    {
      what: "a function",
      create: `CREATE FUNCTION public.openbrf_trigger_check_${suffix}_planted(integer) RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      object: `FUNCTION public.openbrf_trigger_check_${suffix}_planted(integer)`,
      handover: `ROUTINE public.openbrf_trigger_check_${suffix}_planted(integer)`,
      reported: `public.openbrf_trigger_check_${suffix}_planted(integer) is a function`,
    },
    {
      what: "a procedure",
      create: `CREATE PROCEDURE public.openbrf_trigger_check_${suffix}_planted(integer) LANGUAGE sql AS 'SELECT 1'`,
      object: `PROCEDURE public.openbrf_trigger_check_${suffix}_planted(integer)`,
      handover: `ROUTINE public.openbrf_trigger_check_${suffix}_planted(integer)`,
      reported: `public.openbrf_trigger_check_${suffix}_planted(integer) is a procedure`,
    },
    {
      what: "an operator",
      create:
        "CREATE OPERATOR public.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = pg_catalog.texteq)",
      object: "OPERATOR public.=== (text, text)",
      handover: "OPERATOR public.=== (text, text)",
      reported: "public.===(text,text) is an operator",
    },
  ])(
    "stops on $what in public that another role owns, until the owner is given it",
    async ({ create, object, handover, reported }) => {
      // What a role with CREATE in public, which a database restored from a
      // dump before PostgreSQL 15 gives every role, could have left there for
      // a name in a migration to resolve to.
      await asOwner(create);
      try {
        await asOwner(`ALTER ${object} OWNER TO ${PROBE_ROLE}`);
        const refused = check();
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain(
          `${reported} that ${PROBE_ROLE} owns, not the schema owner.`,
        );
        expect(refused.output).toContain("So the deploy stops here.");

        // The statement the message names hands it over: ALTER FUNCTION
        // refuses a procedure, ALTER ROUTINE takes either.
        const statement = handover.split(" ")[0];
        expect(refused.output).toContain(`ALTER ${statement} ... OWNER TO`);
        await asOwner(`ALTER ${handover} OWNER TO CURRENT_USER`);
        const passed = check();
        expect(passed.status, passed.output).toBe(0);
      } finally {
        await asOwner(`DROP ${object}`);
      }
    },
    60_000,
  );

  it.each([
    { grants: "the grants it was created with", grant: undefined },
    {
      grants: "a CREATE grant of its own",
      grant: `GRANT CREATE ON SCHEMA pgboss TO ${PROBE_ROLE}`,
    },
  ])(
    "stops while another role owns pgboss, with $grants",
    async ({ grant }) => {
      // An instance on a shared server does not run the schema-owner service,
      // which would hand the schema to the owner. Its owner can create in it
      // whatever its grants say, and replace what pg-boss put there.
      const databaseUrl = await scratch.create("triggers_schema_owner");
      await withClient(databaseUrl, async (client) => {
        await client.query(`CREATE SCHEMA pgboss AUTHORIZATION ${PROBE_ROLE}`);
        if (grant !== undefined) {
          await client.query(grant);
        }
      });
      const refused = check(databaseUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `pgboss belongs to ${PROBE_ROLE}, not the schema owner.`,
      );
      expect(refused.output).toContain("ALTER SCHEMA ... OWNER TO");
      expect(refused.output).toContain("So the deploy stops here.");
      if (grant !== undefined) {
        expect(refused.output).toContain(
          `${PROBE_ROLE} holds CREATE in pgboss.`,
        );
      }
    },
    60_000,
  );

  it("stops while public belongs to pg_database_owner and the database to another role", async () => {
    // pg_database_owner stands for whoever owns the database, which here is
    // not the role the check runs as.
    const databaseUrl = await scratch.create("triggers_database_owner");
    await withClient(databaseUrl, (client) =>
      client.query(
        `DO $$ BEGIN
           EXECUTE format('ALTER DATABASE %I OWNER TO ${PROBE_ROLE}', current_database());
         END $$`,
      ),
    );
    const refused = check(databaseUrl);
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain(
      `public belongs to pg_database_owner, which stands for ${PROBE_ROLE}, ` +
        "not the schema owner.",
    );
    expect(refused.output).toContain(
      "pg_database_owner holds CREATE in public.",
    );
  }, 60_000);

  it.each([
    { grantee: "PUBLIC", schema: "public" },
    { grantee: PROBE_ROLE, schema: "pgboss" },
  ])(
    "stops while $grantee holds CREATE in $schema",
    async ({ grantee, schema }) => {
      // PUBLIC in public is what a database restored from a dump before
      // PostgreSQL 15 holds. The hardening revokes it, but after the
      // migrations have run as the owner.
      await asOwner(`GRANT CREATE ON SCHEMA ${schema} TO ${grantee}`);
      try {
        const refused = check();
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain(
          `${grantee} holds CREATE in ${schema}.`,
        );
        expect(refused.output).toContain("So the deploy stops here.");
      } finally {
        await asOwner(`REVOKE CREATE ON SCHEMA ${schema} FROM ${grantee}`);
      }
    },
    60_000,
  );

  it("stops a first deploy whose owner gives another role CREATE by default in the schemas it creates", async () => {
    // The job schema install creates pgboss as the owner, so the role would
    // hold CREATE there from the moment it exists.
    const databaseUrl = await scratch.create("triggers_create_defaults");
    await withClient(databaseUrl, (client) =>
      client.query(
        `ALTER DEFAULT PRIVILEGES GRANT CREATE ON SCHEMAS TO ${PROBE_ROLE}`,
      ),
    );
    try {
      const refused = check(databaseUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `${PROBE_ROLE} is given CREATE by default in the schemas the schema ` +
          "owner creates.",
      );
    } finally {
      await withClient(databaseUrl, (client) =>
        client.query(
          `ALTER DEFAULT PRIVILEGES REVOKE CREATE ON SCHEMAS FROM ${PROBE_ROLE}`,
        ),
      );
    }
  }, 60_000);

  it("calls no function of public's in place of a built-in one", async () => {
    // The owner's own search path takes in public, and PostgreSQL takes the
    // best match for a call's arguments from every schema on it: pg_catalog
    // wins only a tie. quote_ident takes text, and the role names the check
    // quotes are of type name, so a quote_ident(name) in public would be
    // called instead, as the owner. It is the owner's own here, so that only
    // the path is at stake; one of another role's is refused in its own right.
    const MARKER = `search_path probe ${suffix}`;
    const databaseUrl = await scratch.create("triggers_search_path");
    await withClient(databaseUrl, async (client) => {
      await client.query(
        `CREATE FUNCTION public.quote_ident(name) RETURNS text LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION '${MARKER}'; END $$`,
      );
      // A finding for the check to name, and so a role name to quote.
      await client.query(
        `ALTER DEFAULT PRIVILEGES GRANT TRIGGER ON TABLES TO ${PROBE_ROLE}`,
      );
    });
    try {
      const refused = check(databaseUrl);
      expect(refused.output, "the function in public ran").not.toContain(
        MARKER,
      );
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `${PROBE_ROLE} is given TRIGGER by default on the tables the schema ` +
          "owner creates in every schema.",
      );
    } finally {
      await withClient(databaseUrl, (client) =>
        client.query(
          `ALTER DEFAULT PRIVILEGES REVOKE TRIGGER ON TABLES FROM ${PROBE_ROLE}`,
        ),
      );
    }
  }, 60_000);
});

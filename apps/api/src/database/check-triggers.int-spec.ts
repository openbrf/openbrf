import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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
 * What the owner itself can do leaves nothing of another role's behind:
 * dropping a guard, switching it off, or rewriting the function it calls. So
 * the check stops on those as well, and on a role that can act as the owner,
 * or that owns the database or holds CREATE on it.
 *
 * The cases that change a trigger, plant a function or operator, or grant
 * CREATE do so on the worker's database and put it back, so the suites after
 * them meet what the migrations created.
 */

const env = loadEnvForIntegrationTests();

const script = join(process.cwd(), "scripts", "check-triggers.mjs");
const migrations = join(process.cwd(), "prisma", "migrations");

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
  name: string;
  definition: string;
  enabled: boolean;
  ownersFunction: boolean;
  function: string;
}

interface TriggerCheck {
  EXPECTED_TRIGGERS: string[];
  TRIGGER_MIGRATIONS: Map<string, string>;
  EXPECTED_TRIGGER_FUNCTIONS: [string, string][];
  FUNCTION_STATE: string;
  HARMLESS_SETTINGS: Set<string>;
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

/** The role the check runs as in this suite, the owner of its databases. */
const OWNER = new URL(env.DATABASE_URL).username;

/**
 * A role that is not a superuser, made to own a scratch database, and a
 * connection string that signs in as it there: the check as it runs on a
 * shared server, where the schema owner is an ordinary role. Created as the
 * suite's owner, which is one, or as `createdBy`, and dropped with `drop`,
 * after the database.
 */
async function ordinaryOwner(
  label: string,
  ownsTheDatabase = true,
  createdBy?: string,
): Promise<{
  role: string;
  databaseUrl: string;
  ownerUrl: string;
  drop(): Promise<void>;
}> {
  const role = `openbrf_trigger_owner_${suffix}_${label}`;
  const password = randomBytes(16).toString("hex");
  const databaseUrl = await scratch.create(`triggers_${label}`);
  const ownerUrl = new URL(databaseUrl);
  ownerUrl.username = role;
  ownerUrl.password = password;
  await withClient(env.DATABASE_URL, async (client) => {
    if (createdBy !== undefined) {
      await client.query(`SET ROLE ${createdBy}`);
    }
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  });
  if (ownsTheDatabase) {
    await withClient(databaseUrl, (client) =>
      client.query(
        `DO $$ BEGIN
           EXECUTE format('ALTER DATABASE %I OWNER TO ${role}', current_database());
         END $$`,
      ),
    );
  }
  return {
    role,
    databaseUrl,
    ownerUrl: ownerUrl.href,
    async drop() {
      // The database first: the role may own it.
      await scratch.dropAll();
      await asOwner(`DROP ROLE IF EXISTS ${role}`);
    },
  };
}

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
    expect(
      current.filter((trigger) => !trigger.enabled),
      "triggers that do not fire as created",
    ).toEqual([]);
    expect(
      current
        .map((trigger) => trigger.function)
        .filter(
          (state) =>
            !triggers.EXPECTED_TRIGGER_FUNCTIONS.some(
              ([, listed]) => listed === state,
            ),
        ),
      "functions the triggers call, in a form the list does not name",
    ).toEqual([]);
    // Every trigger on the application's tables is looked for once its
    // migration has run; the one on pgboss.queue is the install's.
    expect(
      current
        .filter((trigger) => trigger.table.startsWith("public."))
        .map((trigger) => `${trigger.name} ON ${trigger.table}`)
        .sort(),
    ).toEqual([...triggers.TRIGGER_MIGRATIONS.keys()].sort());
  });

  it("knows the migration that creates each trigger, and every form a migration gives the functions they call", async () => {
    // Applied one at a time, as an instance meets them across its upgrades:
    // the check runs before the migrations, so it has to accept the function
    // each earlier migration left, and look for a trigger only once the
    // migration that creates it has run.
    const databaseUrl = await scratch.create("triggers_history");
    const firstSeen = new Map<string, string>();
    const forms = new Map<string, string>();
    const given: [string, string][] = [];
    await withClient(databaseUrl, async (client) => {
      const names = readdirSync(migrations, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const name of names) {
        await client.query(
          readFileSync(join(migrations, name, "migration.sql"), "utf8"),
        );
        const results = (await client.query(
          `SET LOCAL search_path = pg_catalog, pg_temp;
           SELECT format('%s ON %I.%I', t.tgname, n.nspname, c.relname) AS trigger,
                  p.oid::regprocedure::text AS name,
                  ${triggers.FUNCTION_STATE} AS function
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_language l ON l.oid = p.prolang
           WHERE NOT t.tgisinternal AND n.nspname = 'public'`,
        )) as unknown as {
          rows: { trigger: string; name: string; function: string }[];
        }[];
        for (const row of results.at(-1)?.rows ?? []) {
          if (!firstSeen.has(row.trigger)) {
            firstSeen.set(row.trigger, name);
          }
          if (forms.get(row.name) !== row.function) {
            forms.set(row.name, row.function);
            given.push([name, row.function]);
          }
        }
      }
    });

    expect(
      Object.fromEntries([...firstSeen].sort(([a], [b]) => a.localeCompare(b))),
    ).toEqual(
      Object.fromEntries(
        [...triggers.TRIGGER_MIGRATIONS].sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    const byForm = ([, a]: [string, string], [, b]: [string, string]) =>
      a.localeCompare(b);
    expect(given.sort(byForm)).toEqual(
      triggers.EXPECTED_TRIGGER_FUNCTIONS.filter(([, state]) =>
        state.startsWith("public."),
      ).sort(byForm),
    );
  }, 120_000);

  it("passes the database the migrations and the job schema install built, and says what it found", () => {
    const passed = check();
    expect(passed.status, passed.output).toBe(0);
    const guards = triggers.TRIGGER_MIGRATIONS.size;
    expect(passed.output).toContain(
      "migrations have run, and the guard triggers they created on the " +
        `application's tables, ${guards} of the ${guards}, are all there. ` +
        "Every trigger",
    );
    expect(passed.output).toContain(
      "The one on pgboss.queue is not required here: the job schema install " +
        "puts it back and checks it again.",
    );
    expect(passed.output).toContain(
      "no role is a member of the owner but a superuser. A superuser can " +
        "still act as it.",
    );
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
    expect(passed.output).toContain(
      "No migration that creates a guard trigger on the application's " +
        "tables has run yet, so none was looked for.",
    );
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

  it.each(
    ["public", "pgboss"].flatMap((schema) => {
      const planted = `${schema}.openbrf_trigger_check_${suffix}_planted(integer)`;
      return [
        {
          schema,
          what: "a function",
          create: `CREATE FUNCTION ${planted} RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
          object: `FUNCTION ${planted}`,
          handover: `ROUTINE ${planted}`,
          reported: `${planted} is a function`,
        },
        {
          schema,
          what: "a procedure",
          create: `CREATE PROCEDURE ${planted} LANGUAGE sql AS 'SELECT 1'`,
          object: `PROCEDURE ${planted}`,
          handover: `ROUTINE ${planted}`,
          reported: `${planted} is a procedure`,
        },
        {
          schema,
          what: "an aggregate",
          create: `CREATE AGGREGATE ${planted} (SFUNC = pg_catalog.int4pl, STYPE = integer)`,
          object: `AGGREGATE ${planted}`,
          handover: `ROUTINE ${planted}`,
          reported: `${planted} is an aggregate`,
        },
        {
          schema,
          what: "an operator",
          create: `CREATE OPERATOR ${schema}.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = pg_catalog.texteq)`,
          object: `OPERATOR ${schema}.=== (text, text)`,
          handover: `OPERATOR ${schema}.=== (text, text)`,
          reported: `${schema}.===(text,text) is an operator`,
        },
      ];
    }),
  )(
    "stops on $what in $schema that another role owns, until the owner is given it",
    async ({ create, object, handover, reported }) => {
      // What a role with CREATE in the schema, which a database restored from
      // a dump before PostgreSQL 15 gives every role in public, could have
      // left there for a name in a migration to resolve to.
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
        // refuses a procedure, ALTER ROUTINE takes any of the three.
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

  it("stops on a function of another role's that it added to an extension of its own, and passes the extension", async () => {
    // A role trusted with an extension owns the extension, and can add a
    // function of its own to it with ALTER EXTENSION ... ADD; what the
    // extension created belongs to the bootstrap superuser. The check runs as
    // a database owner that is not a superuser, as on a shared server, so
    // that the superuser's objects are not the running role's own.
    const MARKER = `planted quote_ident ${suffix}`;
    const OWNER_ROLE = `openbrf_trigger_owner_${suffix}`;
    const OWNER_PASSWORD = randomBytes(16).toString("hex");
    const databaseUrl = await scratch.create("triggers_extension");
    const asDatabaseOwner = new URL(databaseUrl);
    asDatabaseOwner.username = OWNER_ROLE;
    asDatabaseOwner.password = OWNER_PASSWORD;
    await asOwner(
      `CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PASSWORD}'`,
    );
    try {
      await withClient(databaseUrl, async (client) => {
        await client.query(
          `DO $$ BEGIN
             EXECUTE format('ALTER DATABASE %I OWNER TO ${OWNER_ROLE}', current_database());
             EXECUTE format('GRANT CREATE ON DATABASE %I TO ${PROBE_ROLE}', current_database());
           END $$`,
        );
        await client.query(`GRANT CREATE ON SCHEMA public TO ${PROBE_ROLE}`);
        // What the role leaves behind while it holds CREATE: hstore is a
        // trusted extension, and quote_ident(name) wins over the built-in
        // for a role name, as the case on the search path below says.
        await client.query(`SET ROLE ${PROBE_ROLE}`);
        await client.query("CREATE EXTENSION hstore SCHEMA public");
        await client.query(
          `CREATE FUNCTION public.quote_ident(name) RETURNS text LANGUAGE plpgsql
           AS $$ BEGIN RAISE EXCEPTION '${MARKER} ran as %', current_user; END $$`,
        );
        await client.query("RESET ROLE");
        await client.query(
          `DO $$ BEGIN
             EXECUTE format('REVOKE CREATE ON DATABASE %I FROM ${PROBE_ROLE}', current_database());
           END $$`,
        );
        await client.query(`REVOKE CREATE ON SCHEMA public FROM ${PROBE_ROLE}`);
      });
      const reported =
        `public.quote_ident(name) is a function that ${PROBE_ROLE} owns, ` +
        "not the schema owner.";

      const planted = check(asDatabaseOwner.href);
      expect(planted.status, planted.output).toBe(1);
      expect(planted.output).toContain(reported);

      // Adding it to the extension asks for no CREATE, only ownership of
      // both, so the role can do it after the revoke.
      await withClient(databaseUrl, async (client) => {
        await client.query(`SET ROLE ${PROBE_ROLE}`);
        await client.query(
          "ALTER EXTENSION hstore ADD FUNCTION public.quote_ident(name)",
        );
      });
      const attached = check(asDatabaseOwner.href);
      expect(attached.output, "the planted function ran").not.toContain(MARKER);
      expect(attached.status, attached.output).toBe(1);
      expect(attached.output).toContain(reported);

      // The extension's own functions and operators, which the bootstrap
      // superuser owns, pass once the planted one is gone.
      await withClient(databaseUrl, async (client) => {
        await client.query(
          "ALTER EXTENSION hstore DROP FUNCTION public.quote_ident(name)",
        );
        await client.query("DROP FUNCTION public.quote_ident(name)");
      });
      const passed = check(asDatabaseOwner.href);
      expect(passed.status, passed.output).toBe(0);
      const extension = await withClient(databaseUrl, async (client) => {
        const result = await client.query<{ owner: string; objects: number }>(
          `SELECT e.extowner::regrole::text AS owner,
                  (SELECT count(*)::int FROM pg_depend d
                   WHERE d.refclassid = 'pg_extension'::regclass
                     AND d.refobjid = e.oid AND d.deptype = 'e') AS objects
           FROM pg_extension e WHERE e.extname = 'hstore'`,
        );
        return result.rows[0];
      });
      expect(extension?.owner).toBe(PROBE_ROLE);
      expect(extension?.objects).toBeGreaterThan(0);
    } finally {
      // The database first: the role owns it.
      await scratch.dropAll();
      await asOwner(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
    }
  }, 90_000);

  it("stops while another role owns public itself, not through pg_database_owner", async () => {
    // A database created before PostgreSQL 15, or a schema handed to a role,
    // has a role of its own as the owner, which can create in public whatever
    // the grants say.
    const databaseUrl = await scratch.create("triggers_public_owner");
    await withClient(databaseUrl, (client) =>
      client.query(`ALTER SCHEMA public OWNER TO ${PROBE_ROLE}`),
    );
    const refused = check(databaseUrl);
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain(
      `public belongs to ${PROBE_ROLE}, not the schema owner.`,
    );
    expect(refused.output).toContain("ALTER SCHEMA ... OWNER TO");
    expect(refused.output).toContain("So the deploy stops here.");
  }, 60_000);

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
    expect(refused.output).toContain(
      `The database ${new URL(databaseUrl).pathname.slice(1)} belongs to ` +
        `${PROBE_ROLE}, not the schema owner.`,
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

  it("stops on a trigger that a migration which has run created and that is gone", async () => {
    // Dropping a trigger takes ownership of its table, which a role acting
    // as the owner has, and leaves nothing for the comparison of the
    // triggers that are there to find. The migration is not run again.
    const original = triggers.EXPECTED_TRIGGERS.find((definition) =>
      definition.startsWith("CREATE TRIGGER transfer_states_what_it_is "),
    );
    expect(original, "the trigger is one the list names").toBeDefined();
    await asOwner("DROP TRIGGER transfer_states_what_it_is ON public.transfer");
    try {
      const refused = check();
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        "public.transfer is missing the trigger transfer_states_what_it_is, " +
          "which the migration 20260912230000_transfer_write_guards created.",
      );
      expect(refused.output).toContain("So the deploy stops here.");
    } finally {
      await asOwner(original ?? "");
    }
  }, 60_000);

  it("looks for a trigger only once the migration that creates it has run, and not for the one on pgboss.queue", async () => {
    // An upgrade meets the tables an earlier migration created before the one
    // that guards them, and the job schema install puts back the trigger on
    // pgboss.queue after this check.
    const databaseUrl = await scratch.create("triggers_not_yet");
    await withClient(databaseUrl, async (client) => {
      await client.query(
        `CREATE TABLE public._prisma_migrations (
           migration_name text NOT NULL,
           finished_at timestamptz,
           rolled_back_at timestamptz)`,
      );
      await client.query(
        `INSERT INTO public._prisma_migrations VALUES
           ('20260913200000_oauth_provider', now(), NULL),
           ('20261008100100_oauth_client_stays_disabled', NULL, NULL),
           ('20261008100100_oauth_client_stays_disabled', now(), now())`,
      );
      await client.query("CREATE TABLE public.auth_oauth_client (id text)");
      await client.query("CREATE SCHEMA pgboss");
      await client.query("CREATE TABLE pgboss.queue (name text)");
    });
    const passed = check(databaseUrl);
    expect(passed.status, passed.output).toBe(0);

    await withClient(databaseUrl, (client) =>
      client.query(
        `INSERT INTO public._prisma_migrations
         VALUES ('20261008100100_oauth_client_stays_disabled', now(), NULL)`,
      ),
    );
    const refused = check(databaseUrl);
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain(
      "public.auth_oauth_client is missing the trigger " +
        "oauth_client_stays_disabled, which the migration " +
        "20261008100100_oauth_client_stays_disabled created.",
    );
    expect(refused.output).not.toContain("refuse_own_job_table");
  }, 60_000);

  it("stops while another role owns the table the migrations record what they applied in", async () => {
    // Reading a view or a table with a policy of another role's would run
    // whatever function it calls as the owner, so it is not read, and the
    // missing triggers cannot be looked for.
    const databaseUrl = await scratch.create("triggers_record");
    await withClient(databaseUrl, async (client) => {
      await client.query(
        "CREATE TABLE public._prisma_migrations (migration_name text)",
      );
      await client.query(
        `ALTER TABLE public._prisma_migrations OWNER TO ${PROBE_ROLE}`,
      );
    });
    const refused = check(databaseUrl);
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain(
      "public._prisma_migrations, where the migrations record what they " +
        `have applied, is not a table the schema owner owns: ${PROBE_ROLE} ` +
        "owns it.",
    );
  }, 60_000);

  it("stops while the table the migrations record what they applied in forces row-level security, and runs none of its policies", async () => {
    // Forced, a policy applies to the table's owner too, and can hide the row
    // of the migration that created a guard, so that the guard is not looked
    // for; the function it calls runs as the owner. A superuser passes every
    // policy, so the check runs as an owner that is not one.
    const owner = await ordinaryOwner("history");
    try {
      await withClient(owner.ownerUrl, async (client) => {
        await client.query(
          `CREATE TABLE public._prisma_migrations (
             migration_name text NOT NULL,
             finished_at timestamptz,
             rolled_back_at timestamptz)`,
        );
        await client.query(
          `INSERT INTO public._prisma_migrations
           VALUES ('20261008100100_oauth_client_stays_disabled', now(), NULL)`,
        );
        await client.query("CREATE TABLE public.auth_oauth_client (id text)");
        await client.query("CREATE TABLE public.policy_ran (by_role text)");
        await client.query(
          `CREATE FUNCTION public.hide_migrations() RETURNS boolean
           LANGUAGE plpgsql
           AS $$ BEGIN
             INSERT INTO public.policy_ran VALUES (current_user);
             RETURN false;
           END $$`,
        );
      });
      const missing = check(owner.ownerUrl);
      expect(missing.status, missing.output).toBe(1);
      expect(missing.output).toContain(
        "public.auth_oauth_client is missing the trigger " +
          "oauth_client_stays_disabled",
      );

      await withClient(owner.ownerUrl, async (client) => {
        await client.query(
          `CREATE POLICY hide_migrations ON public._prisma_migrations
           USING (public.hide_migrations())`,
        );
        await client.query(
          `ALTER TABLE public._prisma_migrations
           ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY`,
        );
      });
      const refused = check(owner.ownerUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        "public._prisma_migrations, where the migrations record what they " +
          "have applied, forces row-level security on the schema owner, so a " +
          "policy decides which of its rows the owner sees.",
      );
      expect(refused.output).toContain("NO FORCE ROW LEVEL SECURITY");
      expect(refused.output).toContain("So the deploy stops here.");
      const ran = await withClient(owner.ownerUrl, async (client) => {
        const result = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM public.policy_ran",
        );
        return result.rows[0]?.count;
      });
      expect(ran, "times the policy's function ran").toBe(0);
    } finally {
      await owner.drop();
    }
  }, 60_000);

  it("stops while the table the migrations record what they applied in has a child table or a parent", async () => {
    // Prisma reads a child's rows as the table's own, so the row of the
    // migration that created a guard, moved into one, still counts as applied
    // and the migration is not run again, but the check would not see it.
    const databaseUrl = await scratch.create("triggers_inherited");
    await withClient(databaseUrl, async (client) => {
      await client.query(
        `CREATE TABLE public._prisma_migrations (
           migration_name text NOT NULL,
           finished_at timestamptz,
           rolled_back_at timestamptz)`,
      );
      await client.query(
        `INSERT INTO public._prisma_migrations
         VALUES ('20261008100100_oauth_client_stays_disabled', now(), NULL)`,
      );
      await client.query("CREATE TABLE public.auth_oauth_client (id text)");
    });
    const missing = check(databaseUrl);
    expect(missing.status, missing.output).toBe(1);
    expect(missing.output).toContain(
      "public.auth_oauth_client is missing the trigger " +
        "oauth_client_stays_disabled",
    );

    const seen = await withClient(databaseUrl, async (client) => {
      await client.query(
        `CREATE TABLE public.moved_migrations ()
         INHERITS (public._prisma_migrations)`,
      );
      await client.query(
        `WITH moved AS (DELETE FROM ONLY public._prisma_migrations RETURNING *)
         INSERT INTO public.moved_migrations SELECT * FROM moved`,
      );
      const result = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public._prisma_migrations",
      );
      return result.rows[0]?.count;
    });
    expect(seen, "the rows Prisma reads").toBe(1);
    const child = check(databaseUrl);
    expect(child.status, child.output).toBe(1);
    expect(child.output).toContain(
      "public._prisma_migrations, where the migrations record what they " +
        "have applied, takes part in table inheritance with " +
        "public.moved_migrations,",
    );
    expect(child.output).toContain("NO INHERIT");
    expect(child.output).toContain("So the deploy stops here.");

    await withClient(databaseUrl, async (client) => {
      await client.query(
        `ALTER TABLE public.moved_migrations
         NO INHERIT public._prisma_migrations`,
      );
      await client.query(
        `ALTER TABLE public._prisma_migrations
         INHERIT public.moved_migrations`,
      );
    });
    const parent = check(databaseUrl);
    expect(parent.status, parent.output).toBe(1);
    expect(parent.output).toContain(
      "takes part in table inheritance with public.moved_migrations,",
    );
  }, 60_000);

  it.each([
    { how: "disabled", off: "DISABLE TRIGGER" },
    {
      how: "made to fire only while replicating",
      off: "ENABLE REPLICA TRIGGER",
    },
  ])(
    "stops on a trigger $how",
    async ({ off }) => {
      // Either takes ownership of the table, and the trigger reads as created.
      await asOwner(
        `ALTER TABLE public.transfer ${off} transfer_states_what_it_is`,
      );
      try {
        const refused = check();
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain(
          "public.transfer has a trigger that does not fire as it was " +
            "created, in every session but a replicating one: CREATE " +
            "TRIGGER transfer_states_what_it_is ",
        );
        expect(refused.output).toContain("ENABLE TRIGGER");
      } finally {
        await asOwner(
          "ALTER TABLE public.transfer ENABLE TRIGGER transfer_states_what_it_is",
        );
      }
    },
    60_000,
  );

  it.each([
    {
      what: "a body that lets every row through",
      guard: "public.openbrf_check_transfer_record()",
      change: `CREATE OR REPLACE FUNCTION public.openbrf_check_transfer_record()
               RETURNS trigger LANGUAGE plpgsql
               SET search_path = pg_catalog, pg_temp
               AS $$ BEGIN RETURN NEW; END $$`,
      reported:
        "public.openbrf_check_transfer_record() LANGUAGE plpgsql " +
        "SET search_path=pg_catalog, pg_temp BODY ",
    },
    {
      what: "the search_path the migrations pinned taken away",
      guard: "public.openbrf_keep_oauth_client_disabled()",
      change:
        "ALTER FUNCTION public.openbrf_keep_oauth_client_disabled() RESET search_path",
      reported:
        "public.openbrf_keep_oauth_client_disabled() LANGUAGE plpgsql BODY ",
    },
    {
      what: "SECURITY DEFINER",
      guard: "pgboss.refuse_own_job_table()",
      change: "ALTER FUNCTION pgboss.refuse_own_job_table() SECURITY DEFINER",
      reported:
        "pgboss.refuse_own_job_table() LANGUAGE plpgsql SECURITY DEFINER " +
        "SET search_path=pg_catalog, pg_temp BODY ",
    },
  ])(
    "stops on a guard function given $what, which keeps its owner and its triggers",
    async ({ guard, change, reported }) => {
      // CREATE OR REPLACE FUNCTION and ALTER FUNCTION take ownership of the
      // function, which a role acting as the owner has.
      const original = await withClient(env.DATABASE_URL, async (client) => {
        const result = await client.query<{ definition: string }>(
          "SELECT pg_get_functiondef($1::regprocedure) AS definition",
          [guard],
        );
        return result.rows[0]?.definition ?? "";
      });
      await asOwner(change);
      try {
        const refused = check();
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain(
          "has a trigger calling a function that is not as the migrations " +
            `or the job schema install wrote it: ${reported}`,
        );
        expect(refused.output).toContain("So the deploy stops here.");
      } finally {
        await asOwner(original);
      }
      const passed = check();
      expect(passed.status, passed.output).toBe(0);
    },
    60_000,
  );

  it.each([
    {
      how: "inheriting its privileges",
      grant: "WITH INHERIT TRUE, SET FALSE",
      reported: "can act as the schema owner",
      why: ".",
    },
    {
      how: "able to SET ROLE to it",
      grant: "WITH INHERIT FALSE, SET TRUE",
      reported: "can act as the schema owner",
      why: ".",
    },
    {
      how: "holding only ADMIN OPTION on it, as a role that created it does",
      grant: "WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
      reported: "is a member of the schema owner",
      why: ", and can grant itself the owner's privileges.",
    },
    {
      how: "with none of the options",
      grant: "WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      reported: "is a member of the schema owner",
      why:
        ", and a role holding ADMIN OPTION on the owner can let it act as " +
        "it.",
    },
  ])(
    "stops while a role is a member of the owner $how",
    async ({ grant, reported, why }) => {
      // Whatever such a role does is the owner's, so nothing the other
      // checks look at is another role's. A superuser makes the grant, as
      // only one, or a role holding ADMIN OPTION on the owner, can.
      const owner = await ordinaryOwner("member");
      try {
        const before = check(owner.ownerUrl);
        expect(before.status, before.output).toBe(0);

        await asOwner(`GRANT ${owner.role} TO ${PROBE_ROLE} ${grant}`);
        const after = check(owner.ownerUrl);
        expect(after.status, after.output).toBe(1);
        expect(after.output).toContain(
          `${PROBE_ROLE} ${reported} ${owner.role}${why}`,
        );
        expect(after.output).toContain("REVOKE the schema owner FROM");
        expect(after.output).toContain("So the deploy stops here.");
      } finally {
        // Dropping the owner takes the membership with it.
        await owner.drop();
      }
    },
    60_000,
  );

  it("stops while the administrator that created the owner keeps the ADMIN OPTION it got, and passes once that administrator is dropped", async () => {
    // On PostgreSQL 16 and later a role that creates another without being a
    // superuser holds ADMIN OPTION on it, in the bootstrap superuser's name,
    // and can grant itself the owner's privileges with it. Only a superuser
    // can revoke it; dropping the administrator takes it away as well, which
    // is how docs/deployment.md has a managed server create the owner.
    const administrator = `openbrf_trigger_creator_${suffix}`;
    await asOwner(`CREATE ROLE ${administrator} NOLOGIN CREATEROLE`);
    const owner = await ordinaryOwner("created", true, administrator);
    try {
      const refused = check(owner.ownerUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `${administrator} is a member of the schema owner ${owner.role}, and ` +
          "can grant itself the owner's privileges.",
      );
      expect(refused.output).toContain("docs/deployment.md");

      await asOwner(`DROP ROLE ${administrator}`);
      const passed = check(owner.ownerUrl);
      expect(passed.status, passed.output).toBe(0);
    } finally {
      await owner.drop();
      await asOwner(`DROP ROLE IF EXISTS ${administrator}`);
    }
  }, 60_000);

  it.each([
    {
      what: "a search_path stored for the owner",
      store: (role: string) => `ALTER ROLE ${role} SET search_path = public`,
      reported: (role: string) =>
        `The schema owner ${role} has the stored setting search_path=public.`,
    },
    {
      what: "a setting stored for the owner that changes what a guard function computes",
      store: (role: string) =>
        `ALTER ROLE ${role} SET transform_null_equals = on`,
      reported: (role: string) =>
        `The schema owner ${role} has the stored setting ` +
        "transform_null_equals=on.",
    },
    {
      what: "a setting stored for the owner in its database that it does not know, beside one it does",
      store: (role: string, database: string) =>
        `ALTER ROLE ${role} IN DATABASE ${database} SET check_function_bodies = off;
         ALTER ROLE ${role} IN DATABASE ${database} SET work_mem = '8MB'`,
      reported: (role: string, database: string) =>
        `The schema owner ${role}, in the database ${database}, has the ` +
        "stored setting check_function_bodies=off.",
    },
    {
      what: "a search_path stored for the database",
      store: (_role: string, database: string) =>
        `ALTER DATABASE ${database} SET search_path = public`,
      reported: (_role: string, database: string) =>
        `The database ${database} has the stored setting search_path=public.`,
    },
    {
      what: "a setting stored for the database that stops triggers firing",
      store: (_role: string, database: string) =>
        `ALTER DATABASE ${database} SET session_replication_role = replica`,
      reported: (_role: string, database: string) =>
        `The database ${database} has the stored setting ` +
        "session_replication_role=replica.",
    },
  ])(
    "stops on $what",
    async ({ store, reported }) => {
      // Each applies to every session of the owner's that does not set it,
      // the migrations' among them, and the owner can store it itself, or as
      // the database's owner. A superuser stores them here, as only one can
      // store session_replication_role.
      const owner = await ordinaryOwner("settings");
      const database = new URL(owner.databaseUrl).pathname.slice(1);
      try {
        await asOwner(store(owner.role, database));
        const refused = check(owner.ownerUrl);
        expect(refused.status, refused.output).toBe(1);
        expect(refused.output).toContain(reported(owner.role, database));
        expect(refused.output).toContain("ALTER ROLE ... RESET");
        expect(refused.output).toContain("So the deploy stops here.");
      } finally {
        // Dropping the role and the database takes their settings with them.
        await owner.drop();
      }
    },
    60_000,
  );

  it.each([
    {
      what: "the owner",
      store: (role: string) => `ALTER ROLE ${role} SET work_mem = '8MB'`,
    },
    {
      what: "the owner in its database",
      store: (role: string, database: string) =>
        `ALTER ROLE ${role} IN DATABASE ${database} SET statement_timeout = '5min'`,
    },
    {
      what: "the database",
      store: (_role: string, database: string) =>
        `ALTER DATABASE ${database} SET work_mem = '8MB'`,
    },
    {
      what: "the owner, a planner cost",
      store: (role: string) => `ALTER ROLE ${role} SET cpu_tuple_cost = 0.02`,
    },
    {
      what: "the owner in its database, planner costs",
      store: (role: string, database: string) =>
        `ALTER ROLE ${role} IN DATABASE ${database} SET parallel_setup_cost = 2000;
         ALTER ROLE ${role} IN DATABASE ${database} SET cpu_operator_cost = 0.005`,
    },
    {
      what: "the database, planner costs",
      store: (_role: string, database: string) =>
        `ALTER DATABASE ${database} SET cpu_tuple_cost = 0.02;
         ALTER DATABASE ${database} SET jit_above_cost = 200000`,
    },
  ])(
    "passes a setting of memory, time or planner cost stored for $what",
    async ({ store }) => {
      const owner = await ordinaryOwner("harmless_setting");
      const database = new URL(owner.databaseUrl).pathname.slice(1);
      try {
        await asOwner(store(owner.role, database));
        const passed = check(owner.ownerUrl);
        expect(passed.status, passed.output).toBe(0);
      } finally {
        await owner.drop();
      }
    },
    60_000,
  );

  it("passes only settings the server knows", async () => {
    // A name misspelt in the list would pass nothing, and a setting it meant
    // would stop the deploy.
    const known = await withClient(env.DATABASE_URL, async (client) => {
      const result = await client.query<{ name: string }>(
        "SELECT lower(name) AS name FROM pg_settings",
      );
      return new Set(result.rows.map((row) => row.name));
    });
    expect(
      [...triggers.HARMLESS_SETTINGS].filter((name) => !known.has(name)),
    ).toEqual([]);
  });

  it("passes every planner cost constant the server has", async () => {
    // Settings docs/deployment.md promises pass. One a later release adds
    // fails here, so someone looks at it before a deploy is stopped on it.
    const costs = await withClient(env.DATABASE_URL, async (client) => {
      const result = await client.query<{ name: string }>(
        `SELECT lower(name) AS name FROM pg_settings
         WHERE category = 'Query Tuning / Planner Cost Constants'`,
      );
      return result.rows.map((row) => row.name);
    });
    expect(costs.length).toBeGreaterThan(0);
    expect(
      costs.filter((name) => !triggers.HARMLESS_SETTINGS.has(name)),
    ).toEqual([]);
  });

  it("stops while a role can act as the owner through a role that is a member of it", async () => {
    const owner = await ordinaryOwner("chain");
    const middle = `openbrf_trigger_middle_${suffix}`;
    await asOwner(`CREATE ROLE ${middle} NOLOGIN`);
    try {
      await asOwner(`GRANT ${owner.role} TO ${middle}`);
      await asOwner(`GRANT ${middle} TO ${PROBE_ROLE}`);
      const refused = check(owner.ownerUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `${middle} can act as the schema owner ${owner.role}.`,
      );
      expect(refused.output).toContain(
        `${PROBE_ROLE} can act as the schema owner ${owner.role}.`,
      );
    } finally {
      await asOwner(`DROP ROLE IF EXISTS ${middle}`);
      await owner.drop();
    }
  }, 60_000);

  it("stops while the database belongs to a role other than the owner, a superuser among them", async () => {
    // A superuser that owns the database makes public, through
    // pg_database_owner, one the check trusts, but only the database's owner
    // can close it to the other roles on the server.
    const owner = await ordinaryOwner("database", false);
    try {
      const refused = check(owner.ownerUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `The database ${new URL(owner.databaseUrl).pathname.slice(1)} ` +
          `belongs to ${OWNER}, not the schema owner.`,
      );
      expect(refused.output).toContain("ALTER DATABASE ... OWNER TO");
      expect(refused.output).toContain("So the deploy stops here.");
    } finally {
      await owner.drop();
    }
  }, 60_000);

  it.each([{ grantee: PROBE_ROLE }, { grantee: "PUBLIC" }])(
    "stops while $grantee holds CREATE on the database",
    async ({ grantee }) => {
      // Enough to create a schema named after the owner, which comes before
      // public on its search_path, or a trusted extension of its own.
      const databaseUrl = await scratch.create("triggers_database_create");
      const database = new URL(databaseUrl).pathname.slice(1);
      await withClient(databaseUrl, (client) =>
        client.query(`GRANT CREATE ON DATABASE ${database} TO ${grantee}`),
      );
      const refused = check(databaseUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(
        `${grantee} holds CREATE on the database ${database}.`,
      );
      expect(refused.output).toContain("REVOKE CREATE ON DATABASE");
      expect(refused.output).toContain("So the deploy stops here.");
    },
    60_000,
  );

  it.each([
    {
      what: "that another role owns",
      plant: `DO $$ BEGIN
                EXECUTE format('CREATE SCHEMA %I AUTHORIZATION ${PROBE_ROLE}', current_user);
              END $$`,
      reported: `${OWNER} belongs to ${PROBE_ROLE}, not the schema owner.`,
    },
    {
      what: "that the owner owns, with a function of another role's in it",
      plant: `DO $$ BEGIN
                EXECUTE format('CREATE SCHEMA %I', current_user);
                EXECUTE format('CREATE FUNCTION %I.openbrf_planted(integer) RETURNS integer LANGUAGE sql AS ''SELECT 1''', current_user);
                EXECUTE format('ALTER FUNCTION %I.openbrf_planted(integer) OWNER TO ${PROBE_ROLE}', current_user);
              END $$`,
      reported: `${OWNER}.openbrf_planted(integer) is a function that ${PROBE_ROLE} owns, not the schema owner.`,
    },
    {
      what: "that the owner owns, and every role can create in",
      plant: `DO $$ BEGIN
                EXECUTE format('CREATE SCHEMA %I', current_user);
                EXECUTE format('GRANT CREATE ON SCHEMA %I TO PUBLIC', current_user);
              END $$`,
      reported: `PUBLIC holds CREATE in ${OWNER}.`,
    },
  ])(
    "stops on a schema named after the owner $what",
    async ({ plant, reported }) => {
      // "$user" comes before public on the owner's default search_path, so a
      // name its SQL calls can resolve to a function there.
      const databaseUrl = await scratch.create("triggers_user_schema");
      await withClient(databaseUrl, (client) => client.query(plant));
      const refused = check(databaseUrl);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(reported);
      expect(refused.output).toContain("So the deploy stops here.");
    },
    60_000,
  );
});

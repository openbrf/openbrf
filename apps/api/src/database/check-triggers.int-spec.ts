import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BASE_URL_VARIABLE,
  databaseName,
  maintenanceUrl,
  quoteIdentifier,
  withDatabase,
} from "../testing/integration-database";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

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
 * The cases that change a trigger do so on the worker's database and put it
 * back, so the suites after them meet the triggers the migrations created.
 */

const env = loadEnvForIntegrationTests();

const script = join(process.cwd(), "scripts", "check-triggers.mjs");

const suffix = process.hrtime
  .bigint()
  .toString(36)
  .replace(/[^a-z0-9]/gi, "");
/** A role other than the owner, standing for one that held TRIGGER. */
const PROBE_ROLE = `openbrf_trigger_check_${suffix}`;
/** A function of that role's, for a trigger to call. */
const PROBE_FUNCTION = `public.openbrf_trigger_check_${suffix}`;

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

async function withClient<T>(
  url: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
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

const scratch: string[] = [];

/**
 * An empty database, as a first deploy meets it before any migration has run.
 * Dropped again once the suite is done.
 */
async function emptyDatabase(label: string): Promise<string> {
  const baseUrl = process.env[BASE_URL_VARIABLE] ?? env.DATABASE_URL;
  const name = `${databaseName(baseUrl)}_test_${process.env.VITEST_POOL_ID ?? "1"}_${label}`;
  await withClient(maintenanceUrl(baseUrl), async (client) => {
    await client.query(
      `drop database if exists ${quoteIdentifier(name)} with (force)`,
    );
    await client.query(`create database ${quoteIdentifier(name)}`);
  });
  scratch.push(name);
  return withDatabase(baseUrl, name);
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
  await asOwner(
    `CREATE FUNCTION ${PROBE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
  );
  await asOwner(`ALTER FUNCTION ${PROBE_FUNCTION}() OWNER TO ${PROBE_ROLE}`);
});

afterAll(async () => {
  // The databases first: a default privilege left in one would keep the role.
  const baseUrl = process.env[BASE_URL_VARIABLE] ?? env.DATABASE_URL;
  await withClient(maintenanceUrl(baseUrl), async (client) => {
    for (const name of scratch.splice(0)) {
      await client.query(
        `drop database if exists ${quoteIdentifier(name)} with (force)`,
      );
    }
  });
  await asOwner(`DROP FUNCTION IF EXISTS ${PROBE_FUNCTION}()`);
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
    const passed = check(await emptyDatabase("triggers_empty"));
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
      const databaseUrl = await emptyDatabase("triggers_defaults");
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
});

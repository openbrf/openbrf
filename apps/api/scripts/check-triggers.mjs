/**
 * Checks the triggers on the application's tables and the job schema's, and
 * who can replace them, before anything runs as the schema owner. Also the
 * functions and operators in those schemas, which a name the owner's SQL calls
 * can resolve to, and who can create one.
 *
 * Run at deploy time, as the database owner, before the migrations
 * (docker/entrypoint.sh, step 4): a trigger fires for whoever writes its table,
 * and the migrations write tables as the owner. The job schema install runs
 * the same checks again before pg-boss migrates (scripts/install-job-schema.mjs).
 *
 * Usage:
 *   DATABASE_URL=postgresql://owner:...@host/db node scripts/check-triggers.mjs
 */
import { Client } from "pg";

/**
 * Every trigger the migrations and the job schema install create, as
 * pg_get_triggerdef prints it with search_path set to pg_catalog alone, so that
 * every name in it is schema-qualified.
 *
 * Compared word for word, because CREATE OR REPLACE TRIGGER can change
 * anything about a trigger but its name and its table: the events, a WHEN
 * clause, the function. A migration that adds a trigger adds its line here,
 * and the integration suite compares this list with a migrated database both
 * ways. The check runs before the migrations, so it meets the definitions the
 * instance's last release left. None has changed since it was created; a
 * migration that changes one keeps the old line beside the new.
 */
export const EXPECTED_TRIGGERS = [
  "CREATE TRIGGER refuse_own_job_table BEFORE INSERT OR UPDATE ON pgboss.queue FOR EACH ROW EXECUTE FUNCTION pgboss.refuse_own_job_table()",
  "CREATE TRIGGER audit_log_entry_append_only BEFORE DELETE OR UPDATE ON public.audit_log_entry FOR EACH ROW EXECUTE FUNCTION public.openbrf_forbid_mutation()",
  "CREATE TRIGGER audit_log_entry_no_truncate BEFORE TRUNCATE ON public.audit_log_entry FOR EACH STATEMENT EXECUTE FUNCTION public.openbrf_forbid_truncate()",
  "CREATE TRIGGER oauth_client_stays_disabled BEFORE UPDATE ON public.auth_oauth_client FOR EACH ROW EXECUTE FUNCTION public.openbrf_keep_oauth_client_disabled()",
  "CREATE TRIGGER lien_note_no_delete BEFORE DELETE ON public.lien_note FOR EACH ROW EXECUTE FUNCTION public.openbrf_forbid_mutation()",
  "CREATE TRIGGER lien_note_no_truncate BEFORE TRUNCATE ON public.lien_note FOR EACH STATEMENT EXECUTE FUNCTION public.openbrf_forbid_truncate()",
  "CREATE TRIGGER member_register_entry_append_only BEFORE DELETE OR UPDATE ON public.member_register_entry FOR EACH ROW EXECUTE FUNCTION public.openbrf_forbid_mutation()",
  "CREATE TRIGGER member_register_entry_no_truncate BEFORE TRUNCATE ON public.member_register_entry FOR EACH STATEMENT EXECUTE FUNCTION public.openbrf_forbid_truncate()",
  "CREATE TRIGGER register_report_obligation_append_only BEFORE DELETE OR UPDATE ON public.register_report_obligation FOR EACH ROW EXECUTE FUNCTION public.openbrf_forbid_mutation()",
  "CREATE TRIGGER register_report_obligation_matches_its_event BEFORE INSERT ON public.register_report_obligation FOR EACH ROW EXECUTE FUNCTION public.openbrf_check_report_obligation_event()",
  "CREATE TRIGGER register_report_obligation_no_truncate BEFORE TRUNCATE ON public.register_report_obligation FOR EACH STATEMENT EXECUTE FUNCTION public.openbrf_forbid_truncate()",
  "CREATE TRIGGER termination_append_only BEFORE DELETE OR UPDATE ON public.termination FOR EACH ROW EXECUTE FUNCTION public.openbrf_forbid_mutation()",
  "CREATE TRIGGER termination_no_truncate BEFORE TRUNCATE ON public.termination FOR EACH STATEMENT EXECUTE FUNCTION public.openbrf_forbid_truncate()",
  "CREATE TRIGGER transfer_no_delete BEFORE DELETE ON public.transfer FOR EACH ROW EXECUTE FUNCTION public.openbrf_forbid_mutation()",
  "CREATE TRIGGER transfer_no_truncate BEFORE TRUNCATE ON public.transfer FOR EACH STATEMENT EXECUTE FUNCTION public.openbrf_forbid_truncate()",
  "CREATE TRIGGER transfer_states_what_it_is BEFORE INSERT OR UPDATE ON public.transfer FOR EACH ROW EXECUTE FUNCTION public.openbrf_check_transfer_record()",
  "CREATE TRIGGER transfer_reversal_append_only BEFORE DELETE OR UPDATE ON public.transfer_reversal FOR EACH ROW EXECUTE FUNCTION public.openbrf_forbid_mutation()",
  "CREATE TRIGGER transfer_reversal_matches_its_transfer BEFORE INSERT ON public.transfer_reversal FOR EACH ROW EXECUTE FUNCTION public.openbrf_check_transfer_reversal()",
  "CREATE TRIGGER transfer_reversal_no_truncate BEFORE TRUNCATE ON public.transfer_reversal FOR EACH STATEMENT EXECUTE FUNCTION public.openbrf_forbid_truncate()",
];

/**
 * The rows a query of the catalogs returns, read with search_path pinned to
 * pg_catalog.
 *
 * The owner's own search path takes in public, where a role with CREATE could
 * have put a function or operator that matches the arguments of one these
 * queries call better than the built-in does, and that would run as the
 * owner. pg_get_triggerdef also qualifies a name only where the path would not
 * find it. SET LOCAL holds for the implicit transaction a query of several
 * statements runs in, which the pool cannot split across connections or
 * leave behind on one.
 */
async function catalogRows(db, query) {
  const results = await db.executeSql(
    `SET LOCAL search_path = pg_catalog;\n${query}`,
  );
  return results.at(-1).rows;
}

/** The role this runs as, the schema owner, as an oid. */
const RUNNING_ROLE = "(SELECT oid FROM pg_roles WHERE rolname = current_user)";

/**
 * The roles that may own public or pgboss, or hold CREATE there, as a set of
 * oids: the one this runs as; a superuser, which can do anything in the
 * database whatever it owns, and which owns public in a database created
 * before PostgreSQL 15; and pg_database_owner, which owns public in one
 * created since, while the database's owner it stands for is one of those two.
 */
const TRUSTED_ROLES = `(SELECT r.oid FROM pg_roles r
   WHERE r.rolname = current_user
      OR r.rolsuper
      OR (r.rolname = 'pg_database_owner' AND EXISTS (
            SELECT FROM pg_database d
            JOIN pg_roles o ON o.oid = d.datdba
            WHERE d.datname = current_database()
              AND (o.rolname = current_user OR o.rolsuper))))`;

/** The grantee of an aclexplode row `g`, as a message names it. */
const GRANTEE = `CASE WHEN g.grantee = 0 THEN 'PUBLIC'
                      ELSE quote_ident(pg_get_userbyid(g.grantee)) END`;

/**
 * The triggers on the tables in public and pgboss, each with its definition and
 * whether its table's owner owns the function it calls.
 */
export async function currentTriggers(db) {
  return catalogRows(
    db,
    `SELECT format('%I.%I', n.nspname, c.relname) AS "table",
            pg_get_triggerdef(t.oid) AS definition,
            p.proowner = c.relowner AS "ownersFunction"
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal
       AND n.nspname IN ('public', 'pgboss')
     ORDER BY 1, t.tgname`,
  );
}

/**
 * The triggers that are not one the migrations or the job schema install
 * created, or that call a function their table's owner does not own.
 *
 * CREATE OR REPLACE TRIGGER asks for the TRIGGER privilege on a table and not
 * for its ownership, so a role that held it could have replaced a guard on the
 * statutory archive, or the one on pgboss.queue, with a trigger that does
 * nothing, or added one of its own. The grant is no evidence of that: the
 * runtime role's hardening revokes it, as does the REVOKE an operator who
 * manages the role runs by hand, and both run before an upgrade does. So the
 * triggers themselves are looked at. A function runs as whoever writes the
 * table, so one the owner did not write is refused too, whatever the trigger
 * calling it is named.
 */
async function triggerFindings(db) {
  const expected = new Set(EXPECTED_TRIGGERS);
  const findings = [];
  for (const trigger of await currentTriggers(db)) {
    if (!expected.has(trigger.definition)) {
      findings.push(
        `${trigger.table} has a trigger that is not one the migrations or ` +
          `the job schema install create: ${trigger.definition}`,
      );
    } else if (!trigger.ownersFunction) {
      findings.push(
        `${trigger.table} has a trigger calling a function that the table's ` +
          `owner does not own: ${trigger.definition}`,
      );
    }
  }
  return findings;
}

/**
 * Roles other than a table's owner, or PUBLIC, that hold TRIGGER on a table in
 * public or pgboss, or that the owner's default privileges give it to on every
 * table the owner creates there.
 *
 * The defaults are where a migration's new table, and every table on a fresh
 * install, takes its grants from, so they are read before those tables exist.
 * Only the owner's: the migrations and pg-boss create their tables as the role
 * this runs as. A schema's defaults add to the global ones, so both are read.
 */
async function grantFindings(db) {
  const tables = await catalogRows(
    db,
    `SELECT ${GRANTEE} AS grantee,
            string_agg(format('%I.%I', n.nspname, c.relname), ', '
                       ORDER BY n.nspname, c.relname) AS tables
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) AS g
     WHERE n.nspname IN ('public', 'pgboss')
       AND g.grantee <> c.relowner
       AND g.privilege_type = 'TRIGGER'
     GROUP BY g.grantee
     ORDER BY 1`,
  );
  const defaults = await catalogRows(
    db,
    `SELECT ${GRANTEE} AS grantee,
            string_agg(CASE WHEN d.defaclnamespace = 0 THEN 'every schema'
                            ELSE quote_ident(n.nspname) END, ' and in '
                       ORDER BY n.nspname NULLS FIRST) AS schemas
     FROM pg_default_acl d
     LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     CROSS JOIN LATERAL aclexplode(d.defaclacl) AS g
     WHERE d.defaclrole = ${RUNNING_ROLE}
       AND d.defaclobjtype = 'r'
       AND (d.defaclnamespace = 0 OR n.nspname IN ('public', 'pgboss'))
       AND g.grantee <> d.defaclrole
       AND g.privilege_type = 'TRIGGER'
     GROUP BY g.grantee
     ORDER BY 1`,
  );
  return [
    ...tables.map((row) => `${row.grantee} holds TRIGGER on ${row.tables}.`),
    ...defaults.map(
      (row) =>
        `${row.grantee} is given TRIGGER by default on the tables the schema ` +
        `owner creates in ${row.schemas}.`,
    ),
  ];
}

/**
 * Functions, procedures, aggregates and operators in public or pgboss that a
 * role other than the one this runs as owns.
 *
 * A name a migration or pg-boss's SQL calls without a schema can resolve to
 * one of them: PostgreSQL takes the best match for the arguments from every
 * schema on the path, and pg_catalog wins only a tie. Whatever it resolves to
 * runs as the caller, the schema owner during the migrations among them, and
 * whoever owns it can rewrite what it does. Nothing Open BRF runs creates one
 * as another role, and the schema-owner service hands what the superuser's
 * migrations created to the owner, so one that is left was put there by hand,
 * or by a role holding CREATE in the schema. What an extension installed is
 * left out: only a superuser, or a role trusted with the extension, installs
 * one, and the extension owns it.
 */
async function objectFindings(db) {
  const rows = await catalogRows(
    db,
    `SELECT objects.kind, objects.name,
            quote_ident(pg_get_userbyid(objects.owner)) AS owner
     FROM (
       SELECT CASE p.prokind WHEN 'p' THEN 'a procedure'
                             WHEN 'a' THEN 'an aggregate'
                             WHEN 'w' THEN 'a window function'
                             ELSE 'a function' END AS kind,
              p.oid::regprocedure::text AS name, p.proowner AS owner,
              p.oid AS object, 'pg_proc'::regclass AS catalog
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'pgboss')
       UNION ALL
       SELECT 'an operator', o.oid::regoperator::text, o.oprowner,
              o.oid, 'pg_operator'::regclass
       FROM pg_operator o
       JOIN pg_namespace n ON n.oid = o.oprnamespace
       WHERE n.nspname IN ('public', 'pgboss')
     ) AS objects
     WHERE objects.owner <> ${RUNNING_ROLE}
       AND NOT EXISTS (
         SELECT FROM pg_depend d
         WHERE d.classid = objects.catalog
           AND d.objid = objects.object
           AND d.deptype = 'e'
       )
     ORDER BY objects.name`,
  );
  return rows.map(
    (row) =>
      `${row.name} is ${row.kind} that ${row.owner} owns, not the schema owner.`,
  );
}

/**
 * public or pgboss, where a role other than the one this runs as owns it.
 *
 * A schema's owner can create in it whatever its grants say, and drop or
 * replace what others put there, so one of another role's is the CREATE that
 * createFindings looks for and more. Nothing Open BRF runs creates either
 * schema as another role, and the schema-owner service hands both to the
 * owner, but an instance on a shared server does not run that service.
 * pg_database_owner, which owns public in a database created on PostgreSQL 15
 * or later, stands for whoever owns the database, which need not be the role
 * this runs as.
 */
async function schemaOwnerFindings(db) {
  const rows = await catalogRows(
    db,
    `SELECT quote_ident(n.nspname) AS schema,
            CASE WHEN o.rolname = 'pg_database_owner'
                 THEN format('pg_database_owner, which stands for %I',
                             pg_get_userbyid(d.datdba))
                 ELSE quote_ident(o.rolname) END AS owner
     FROM pg_namespace n
     JOIN pg_roles o ON o.oid = n.nspowner
     JOIN pg_database d ON d.datname = current_database()
     WHERE n.nspname IN ('public', 'pgboss')
       AND n.nspowner NOT IN ${TRUSTED_ROLES}
     ORDER BY n.nspname`,
  );
  return rows.map(
    (row) => `${row.schema} belongs to ${row.owner}, not the schema owner.`,
  );
}

/**
 * Roles other than the one this runs as, or PUBLIC, that hold CREATE in public
 * or pgboss, or that the owner's default privileges give it to in every schema
 * the owner creates.
 *
 * CREATE is all it takes to put a function or operator there for the schema
 * owner to run, as objectFindings says, and one the role puts there later
 * would not be seen. PostgreSQL before 15 gave it in public to PUBLIC, and a
 * database restored from a dump of one keeps the grant. The hardening revokes
 * it, but runs after the migrations. A schema's owner holds it too, so one of
 * another role's is named here as well as in schemaOwnerFindings. The defaults
 * count on a first deploy, when the job schema install creates pgboss as the
 * role this runs as; they apply to schemas in every database, so there are no
 * per-schema ones to read.
 */
async function createFindings(db) {
  const schemas = await catalogRows(
    db,
    `SELECT ${GRANTEE} AS grantee,
            string_agg(quote_ident(n.nspname), ' and '
                       ORDER BY n.nspname) AS schemas
     FROM pg_namespace n
     CROSS JOIN LATERAL aclexplode(n.nspacl) AS g
     WHERE n.nspname IN ('public', 'pgboss')
       AND g.grantee NOT IN ${TRUSTED_ROLES}
       AND g.privilege_type = 'CREATE'
     GROUP BY g.grantee
     ORDER BY 1`,
  );
  const defaults = await catalogRows(
    db,
    `SELECT DISTINCT ${GRANTEE} AS grantee
     FROM pg_default_acl d
     CROSS JOIN LATERAL aclexplode(d.defaclacl) AS g
     WHERE d.defaclrole = ${RUNNING_ROLE}
       AND d.defaclobjtype = 'n'
       AND g.grantee <> d.defaclrole
       AND g.privilege_type = 'CREATE'
     ORDER BY 1`,
  );
  return [
    ...schemas.map((row) => `${row.grantee} holds CREATE in ${row.schemas}.`),
    ...defaults.map(
      (row) =>
        `${row.grantee} is given CREATE by default in the schemas the ` +
        `schema owner creates.`,
    ),
  ];
}

/**
 * Stops the deploy while a trigger on a table in public or pgboss is not one
 * Open BRF created, or while a role other than a table's owner can replace one.
 * Also while a function or operator there belongs to a role other than the
 * schema owner, or while such a role owns either schema or can create in it.
 *
 * `stage` names what stops, in the message: "the deploy" before the
 * migrations, "the install" in the job schema install.
 *
 * Refuses rather than repairs. A trigger that is not the one created, a
 * function or operator of another role's, or a role that could have put either
 * there, means something may have written the archive's tables or the job
 * queue with a guard off, or run code as the owner, and only a person can find
 * out what.
 */
export async function refuseUnsafeTriggers(db, stage) {
  const triggers = await triggerFindings(db);
  const grants = await grantFindings(db);
  const objects = await objectFindings(db);
  const owners = await schemaOwnerFindings(db);
  const creates = await createFindings(db);
  const findings = [...triggers, ...grants, ...objects, ...owners, ...creates];
  if (findings.length === 0) {
    return;
  }
  for (const finding of findings) {
    console.error(finding);
  }
  if (triggers.length > 0) {
    console.error(
      "A trigger runs its function as whoever writes its table, the schema " +
        "owner during the migrations among them, and a guard replaced with " +
        "one that does nothing no longer guards. Find out who changed the " +
        "triggers named above: CREATE OR REPLACE TRIGGER asks only for the " +
        "TRIGGER privilege on a table, and nothing Open BRF runs grants it. " +
        "Then, as the schema owner, put each back from the migration under " +
        "prisma/migrations that creates it, or from " +
        "scripts/install-job-schema.mjs for pgboss.queue, and drop any you " +
        "do not recognise.",
    );
  }
  if (grants.length > 0) {
    console.error(
      "A role holding TRIGGER can replace a trigger on a table it does not " +
        "own: the guards on the statutory archive and on pgboss.queue among " +
        "them. As the role that granted it, REVOKE TRIGGER ON ALL TABLES IN " +
        "SCHEMA public, pgboss FROM each role named above. A grant that " +
        "comes from default privileges (\\ddp in psql) is revoked there, " +
        "with ALTER DEFAULT PRIVILEGES, or the next table created in those " +
        "schemas gets it again.",
    );
  }
  if (objects.length > 0) {
    console.error(
      "A name a migration or pg-boss calls without a schema can resolve to " +
        "a function or operator in public or pgboss, which then runs as the " +
        "schema owner, and whoever owns it can rewrite what it does. Nothing " +
        "Open BRF runs creates one as another role. Find out who created " +
        "those named above and what they do. Then drop each one you do not " +
        "recognise, and hand any you do to the schema owner with ALTER " +
        "ROUTINE ... OWNER TO for a function, procedure or aggregate, or " +
        "ALTER OPERATOR ... OWNER TO, as a superuser.",
    );
  }
  if (owners.length > 0) {
    console.error(
      "A schema's owner can create in it whatever its grants say, and drop " +
        "or replace what is there, so revoking CREATE does not take that " +
        "away. As a superuser, or as the role that owns it, hand each schema " +
        "named above to the schema owner with ALTER SCHEMA ... OWNER TO, " +
        "then look at what that role has put there.",
    );
  }
  if (creates.length > 0) {
    console.error(
      "A role holding CREATE in public or pgboss can put a function or " +
        "operator there for the schema owner to run. PostgreSQL before 15 " +
        "gave CREATE in public to PUBLIC, and a database restored from a dump " +
        "of one keeps the grant. As the schema's owner, REVOKE CREATE ON " +
        "SCHEMA from each role named above, in each schema named. A grant " +
        "that comes from default privileges (\\ddp in psql) is revoked " +
        "there, with ALTER DEFAULT PRIVILEGES, or the next schema the owner " +
        "creates gets it again.",
    );
  }
  console.error(`So ${stage} stops here. Deploy again once that is done.`);
  process.exit(1);
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    console.error(
      "DATABASE_URL is required and must point at the schema owner, not the application role.",
    );
    process.exit(1);
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await refuseUnsafeTriggers(
      { executeSql: (text) => client.query(text) },
      "the deploy",
    );
  } finally {
    await client.end();
  }
  console.log(
    "The triggers are the ones Open BRF creates, and only the schema owner " +
      "can create functions or operators in public and pgboss.",
  );
}

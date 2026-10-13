/**
 * Checks the triggers on the application's tables and the job schema's, the
 * functions they call, and who can replace them, before anything runs as the
 * schema owner. Also the functions and operators in those schemas, which a
 * name the owner's SQL calls can resolve to, and who can create one, who owns
 * the database, which roles are members of the owner, and the settings stored
 * for it.
 *
 * It sees the database as it is when it runs, and no earlier: a guard switched
 * off and back on between two deploys, as the owner, leaves nothing for it to
 * find. docs/deployment.md says how to log that.
 *
 * Run at deploy time, as the database owner, before the migrations
 * (docker/entrypoint.sh, step 4): a trigger fires for whoever writes its table,
 * and the migrations write tables as the owner. The job schema install runs
 * the same checks again before pg-boss migrates (scripts/install-job-schema.mjs).
 *
 * Usage:
 *   DATABASE_URL=postgresql://owner:...@host/db node scripts/check-triggers.mjs
 *
 * OWNER_DB_ADMIN may name one role trusted to be a member of the owner that
 * can grant itself the owner's privileges without holding them (memberFindings).
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
 * The migration that creates each trigger in EXPECTED_TRIGGERS on a table in
 * public, by the trigger's name and its table.
 *
 * Once that migration has run, the trigger has to be there: dropping a guard
 * leaves nothing for a comparison of the triggers that are there to find. One
 * whose migration has not run yet is not looked for, since an upgrade meets
 * the tables an earlier migration created before the one that adds their
 * guard. The trigger on pgboss.queue has no entry: the job schema install puts
 * it back on every deploy, after this check, and checks the rows it guards
 * first. A migration that adds a trigger adds its entry here, and one that
 * drops a trigger takes its entry out; the integration suite applies the
 * migrations one at a time to keep this list true.
 */
export const TRIGGER_MIGRATIONS = new Map([
  [
    "audit_log_entry_append_only ON public.audit_log_entry",
    "20260827122611_statutory_append_only_guards",
  ],
  [
    "lien_note_no_delete ON public.lien_note",
    "20260827122611_statutory_append_only_guards",
  ],
  [
    "member_register_entry_append_only ON public.member_register_entry",
    "20260827122611_statutory_append_only_guards",
  ],
  [
    "transfer_no_delete ON public.transfer",
    "20260827122611_statutory_append_only_guards",
  ],
  [
    "audit_log_entry_no_truncate ON public.audit_log_entry",
    "20260827123622_forbid_truncate_on_statutory_tables",
  ],
  [
    "lien_note_no_truncate ON public.lien_note",
    "20260827123622_forbid_truncate_on_statutory_tables",
  ],
  [
    "member_register_entry_no_truncate ON public.member_register_entry",
    "20260827123622_forbid_truncate_on_statutory_tables",
  ],
  [
    "transfer_no_truncate ON public.transfer",
    "20260827123622_forbid_truncate_on_statutory_tables",
  ],
  [
    "termination_append_only ON public.termination",
    "20260905100000_register_termination",
  ],
  [
    "termination_no_truncate ON public.termination",
    "20260905100000_register_termination",
  ],
  [
    "register_report_obligation_append_only ON public.register_report_obligation",
    "20260910100000_register_report_obligation",
  ],
  [
    "register_report_obligation_matches_its_event ON public.register_report_obligation",
    "20260910100000_register_report_obligation",
  ],
  [
    "register_report_obligation_no_truncate ON public.register_report_obligation",
    "20260910100000_register_report_obligation",
  ],
  [
    "transfer_states_what_it_is ON public.transfer",
    "20260912230000_transfer_write_guards",
  ],
  [
    "transfer_reversal_append_only ON public.transfer_reversal",
    "20260912252000_transfer_reversal",
  ],
  [
    "transfer_reversal_matches_its_transfer ON public.transfer_reversal",
    "20260912252000_transfer_reversal",
  ],
  [
    "transfer_reversal_no_truncate ON public.transfer_reversal",
    "20260912252000_transfer_reversal",
  ],
  [
    "oauth_client_stays_disabled ON public.auth_oauth_client",
    "20261008100100_oauth_client_stays_disabled",
  ],
]);

/**
 * Every form the migrations and the job schema install have given a function
 * that a trigger in EXPECTED_TRIGGERS calls, each with the migration, or the
 * script, that gave it: the function's language, SECURITY DEFINER if it is,
 * its settings, and a SHA-256 of its body, as FUNCTION_STATE prints them.
 *
 * A trigger that reads as created still guards nothing once its function has
 * been rewritten to return, and CREATE OR REPLACE FUNCTION keeps the function's
 * owner and every trigger that calls it, so neither the triggers nor who owns
 * the functions would show it. The check runs before the migrations, so it
 * meets whichever form the instance's last release left: the one the latest
 * migration that has run gave the function, and no earlier one, which would
 * bring back what a later migration fixed. A function no migration that has
 * run gave a form, as the install's is, may have any form listed for it. A
 * migration that changes one adds a line, and the integration suite applies
 * the migrations one at a time to compare this list with what each leaves.
 */
export const EXPECTED_TRIGGER_FUNCTIONS = [
  [
    "20260827122611_statutory_append_only_guards",
    "public.openbrf_forbid_mutation() LANGUAGE plpgsql BODY 4cfe1bab62702b7e8460b295556e31490f5ff8a89786bbb924028da4b49dcd6d",
  ],
  [
    "20260827123622_forbid_truncate_on_statutory_tables",
    "public.openbrf_forbid_truncate() LANGUAGE plpgsql BODY 056bd186de430e093cc345a35db67fb626a2aa06997fbc4ce5966b909a6b542c",
  ],
  [
    "20260827123837_statutory_guard_error_surface",
    "public.openbrf_forbid_mutation() LANGUAGE plpgsql BODY d52eff72d8f5e893459b684839ef7be4ea0bde30a405262558911c175736e32c",
  ],
  [
    "20260827123837_statutory_guard_error_surface",
    "public.openbrf_forbid_truncate() LANGUAGE plpgsql BODY fdf9d0e70185f20f6a403515e328d56dd184d38502de009dade45438207c03d3",
  ],
  [
    "20260910100000_register_report_obligation",
    "public.openbrf_check_report_obligation_event() LANGUAGE plpgsql BODY a1800a087c1985b92b6c8395c1375fa3e9d3a46339387119f042727814ca5bd0",
  ],
  [
    "20260912220000_grant_report_obligation",
    "public.openbrf_check_report_obligation_event() LANGUAGE plpgsql BODY 874cc21dbca0e69e4e1f67c6daa417a90d53a2103e277bbc6beb9126f9bca885",
  ],
  [
    "20260912230000_transfer_write_guards",
    "public.openbrf_check_transfer_record() LANGUAGE plpgsql BODY e74cd7de337c5a173bd86750d6f2a736fd23c3373382c262da19b412ad23443f",
  ],
  [
    "20260912250000_transfer_report_basis",
    "public.openbrf_check_transfer_record() LANGUAGE plpgsql BODY e0a8f63a559d4f1d9e051a55cbc321c9d0cc05cab6574fee78959364daf64aac",
  ],
  [
    "20260912252000_transfer_reversal",
    "public.openbrf_check_report_obligation_event() LANGUAGE plpgsql BODY c4e290b0a69f5288d4077d325a5c6c30575073afb93ad8de978d0f0395b17888",
  ],
  [
    "20260912252000_transfer_reversal",
    "public.openbrf_check_transfer_reversal() LANGUAGE plpgsql BODY 60ec3e9853783616d89f629e2e0fbc117538dd75076b0ba73109d8129cb71f7a",
  ],
  [
    "20261008100100_oauth_client_stays_disabled",
    "public.openbrf_keep_oauth_client_disabled() LANGUAGE plpgsql BODY 1dfba60072c555b641810af7091fa8d188c80d0259d6510e2bfffe3595a2dc8a",
  ],
  [
    "20261010100000_guard_functions_pin_search_path",
    "public.openbrf_check_report_obligation_event() LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp BODY 056fda084ec6df839d1577dadcf890a8b7a4897ca07a054dd090168076b1398c",
  ],
  [
    "20261010100000_guard_functions_pin_search_path",
    "public.openbrf_check_transfer_record() LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp BODY e0a8f63a559d4f1d9e051a55cbc321c9d0cc05cab6574fee78959364daf64aac",
  ],
  [
    "20261010100000_guard_functions_pin_search_path",
    "public.openbrf_check_transfer_reversal() LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp BODY 2620d07f7d0e2217b423bc5f2e3f3099858a8e269e62abd5f4aece88e6d0ff6a",
  ],
  [
    "20261010100000_guard_functions_pin_search_path",
    "public.openbrf_forbid_mutation() LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp BODY d52eff72d8f5e893459b684839ef7be4ea0bde30a405262558911c175736e32c",
  ],
  [
    "20261010100000_guard_functions_pin_search_path",
    "public.openbrf_forbid_truncate() LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp BODY fdf9d0e70185f20f6a403515e328d56dd184d38502de009dade45438207c03d3",
  ],
  [
    "20261010100000_guard_functions_pin_search_path",
    "public.openbrf_keep_oauth_client_disabled() LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp BODY 1dfba60072c555b641810af7091fa8d188c80d0259d6510e2bfffe3595a2dc8a",
  ],
  [
    "scripts/install-job-schema.mjs",
    "pgboss.refuse_own_job_table() LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp BODY 65d10704130d709f4405bce5e5defd6b7028e4cab95f3b0f4e2efc09a11de478",
  ],
];

/**
 * A function `p` as EXPECTED_TRIGGER_FUNCTIONS lists it, with its language from
 * a join of pg_language `l`.
 *
 * The body is hashed with its line endings as LF, so that a migration applied
 * from a checkout with CRLF endings reads the same: a carriage return before a
 * line feed changes nothing PL/pgSQL does with the line.
 */
export const FUNCTION_STATE = `format('%s LANGUAGE %s%s%s BODY %s',
    p.oid::regprocedure, l.lanname,
    CASE WHEN p.prosecdef THEN ' SECURITY DEFINER' END,
    ' SET ' || array_to_string(p.proconfig, ' SET '),
    encode(sha256(convert_to(replace(p.prosrc, E'\\r\\n', E'\\n'), 'UTF8')),
           'hex'))`;

/** The function a form in EXPECTED_TRIGGER_FUNCTIONS is one of. */
function functionOf(state) {
  return state.slice(0, state.indexOf(" LANGUAGE "));
}

/**
 * Whether a function a trigger calls has a form EXPECTED_TRIGGER_FUNCTIONS
 * accepts, once the migrations in `applied` have run.
 */
function expectedFunction(applied) {
  const latest = new Map();
  const listed = new Set();
  for (const [source, state] of EXPECTED_TRIGGER_FUNCTIONS) {
    listed.add(state);
    const name = functionOf(state);
    if (applied.has(source) && source >= (latest.get(name)?.source ?? "")) {
      latest.set(name, { source, state });
    }
  }
  return (state) =>
    latest.has(functionOf(state))
      ? latest.get(functionOf(state)).state === state
      : listed.has(state);
}

/**
 * The rows a query of the catalogs returns, read with search_path pinned to
 * pg_catalog, and to the session's temporary schema after it.
 *
 * The owner's own search path takes in public, where a role with CREATE could
 * have put a function or operator that matches the arguments of one these
 * queries call better than the built-in does, and that would run as the
 * owner. pg_get_triggerdef also qualifies a name only where the path would not
 * find it. pg_temp is named last, as docker/psql.mjs and
 * docker/schema-owner.sql name it, so that it is not searched first for a
 * table or a type. SET LOCAL holds for the implicit transaction a query of
 * several statements runs in, which the pool cannot split across connections
 * or leave behind on one.
 */
async function catalogRows(db, query) {
  const results = await db.executeSql(
    `SET LOCAL search_path = pg_catalog, pg_temp;\n${query}`,
  );
  return results.at(-1).rows;
}

/** The role this runs as, the schema owner, as an oid. */
const RUNNING_ROLE = "(SELECT oid FROM pg_roles WHERE rolname = current_user)";

/**
 * The schemas a name in the owner's SQL can resolve to a function or operator
 * in: public and pgboss, and one named after the role this runs as, which
 * "$user" puts before public on the default search_path. Open BRF creates no
 * schema of that name, but a role holding CREATE on the database can.
 */
const CHECKED_SCHEMAS = "('public', 'pgboss', current_user)";

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
 * The triggers on the tables in public and pgboss, each with its name, its
 * definition, whether it fires as created (tgenabled 'O': in every session but
 * a replicating one), whether its table's owner owns the function it calls,
 * and that function as EXPECTED_TRIGGER_FUNCTIONS lists it.
 */
export async function currentTriggers(db) {
  return catalogRows(
    db,
    `SELECT format('%I.%I', n.nspname, c.relname) AS "table",
            t.tgname AS name,
            pg_get_triggerdef(t.oid) AS definition,
            t.tgenabled = 'O' AS enabled,
            p.proowner = c.relowner AS "ownersFunction",
            ${FUNCTION_STATE} AS function
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid
     JOIN pg_language l ON l.oid = p.prolang
     WHERE NOT t.tgisinternal
       AND n.nspname IN ('public', 'pgboss')
     ORDER BY 1, t.tgname`,
  );
}

/**
 * The migrations prisma migrate deploy has finished, as a set of names, empty
 * before the first; or, as `finding`, why they cannot be read.
 *
 * public._prisma_migrations is read only as a table the role this runs as
 * owns. Reading a view, or a table with a policy, of another role's would run
 * whatever function that role put in it, as the owner.
 *
 * Nor is it read while it forces row-level security, which applies its
 * policies to the owner too: a policy can hide the rows of the migrations that
 * created a guard, so that the guard is not looked for, and the function it
 * calls runs as the owner. Nothing Open BRF runs turns it on, so a role acting
 * as the owner did. The read itself switches row security off, so that a
 * policy put in place after the look fails the read instead of filtering it,
 * and only that table's own rows are read, not a child table's.
 *
 * Nor is it read while it takes part in table inheritance. Prisma reads the
 * rows of a table that inherits from it as its own, so a row moved there
 * still counts as applied to Prisma, and the migration is not run again,
 * while the read above would not see it, and the guard that migration created
 * would not be looked for. Nothing Open BRF runs gives it a parent or a child.
 */
async function appliedMigrations(db) {
  const [record] = await catalogRows(
    db,
    `SELECT c.relkind = 'r' AND c.relowner = ${RUNNING_ROLE} AS owned,
            c.relforcerowsecurity AS "forcesRowSecurity",
            (SELECT string_agg(format('%I.%I', rn.nspname, r.relname), ', '
                               ORDER BY rn.nspname, r.relname)
             FROM pg_inherits i
             JOIN pg_class r ON r.oid IN (i.inhrelid, i.inhparent)
                            AND r.oid <> c.oid
             JOIN pg_namespace rn ON rn.oid = r.relnamespace
             WHERE c.oid IN (i.inhrelid, i.inhparent)) AS inheritance,
            quote_ident(pg_get_userbyid(c.relowner)) AS owner
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = '_prisma_migrations'`,
  );
  if (record === undefined) {
    return { applied: new Set() };
  }
  if (!record.owned) {
    return {
      applied: new Set(),
      finding:
        "public._prisma_migrations, where the migrations record what they " +
        `have applied, is not a table the schema owner owns: ${record.owner} ` +
        "owns it. So the triggers the migrations created cannot be checked " +
        "for.",
    };
  }
  if (record.forcesRowSecurity) {
    return {
      applied: new Set(),
      finding:
        "public._prisma_migrations, where the migrations record what they " +
        "have applied, forces row-level security on the schema owner, so " +
        "a policy decides which of its rows the owner sees. So the triggers " +
        "the migrations created cannot be checked for.",
    };
  }
  if (record.inheritance !== null) {
    return {
      applied: new Set(),
      finding:
        "public._prisma_migrations, where the migrations record what they " +
        "have applied, takes part in table inheritance with " +
        `${record.inheritance}, so rows Prisma counts as applied can be in ` +
        "a table other than it. So the triggers the migrations created " +
        "cannot be checked for.",
    };
  }
  const rows = await catalogRows(
    db,
    `SET LOCAL row_security = off;
     SELECT migration_name AS name FROM ONLY public._prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  return { applied: new Set(rows.map((row) => row.name)) };
}

/**
 * The triggers that are not one the migrations or the job schema install
 * created, that call a function their table's owner does not own or that is
 * not as they wrote it, or that do not fire as they were created. Also the
 * ones a migration that has run created and that are gone.
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
 *
 * Dropping a trigger, switching it off and rewriting its function each take
 * ownership of the table or the function, which a role acting as the owner
 * has, and leave nothing the comparison above would find. The migration that
 * created a trigger is not run again, so one that is missing stays missing.
 * `applied` names the migrations that have run, as appliedMigrations reads
 * them.
 */
async function triggerFindings(db, applied) {
  const expected = new Set(EXPECTED_TRIGGERS);
  const findings = [];
  const expectedState = expectedFunction(applied);
  const present = new Set();
  for (const trigger of await currentTriggers(db)) {
    present.add(`${trigger.name} ON ${trigger.table}`);
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
    } else if (!expectedState(trigger.function)) {
      findings.push(
        `${trigger.table} has a trigger calling a function that is not as ` +
          `the migrations or the job schema install wrote it: ` +
          `${trigger.function}, called by ${trigger.definition}`,
      );
    } else if (!trigger.enabled) {
      findings.push(
        `${trigger.table} has a trigger that does not fire as it was ` +
          `created, in every session but a replicating one: ` +
          trigger.definition,
      );
    }
  }
  for (const [trigger, migration] of TRIGGER_MIGRATIONS) {
    if (applied.has(migration) && !present.has(trigger)) {
      const [name, table] = trigger.split(" ON ");
      findings.push(
        `${table} is missing the trigger ${name}, which the migration ` +
          `${migration} created.`,
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
 * Functions, procedures, aggregates and operators in public or pgboss, or in a
 * schema named after the role this runs as, that a role other than that one
 * owns.
 *
 * A name a migration or pg-boss's SQL calls without a schema can resolve to
 * one of them: PostgreSQL takes the best match for the arguments from every
 * schema on the path, and pg_catalog wins only a tie. Whatever it resolves to
 * runs as the caller, the schema owner during the migrations among them, and
 * whoever owns it can rewrite what it does. Nothing Open BRF runs creates one
 * as another role, and the schema-owner service hands what the superuser's
 * migrations created to the owner, so one that is left was put there by hand,
 * or by a role holding CREATE in the schema. What an extension installed is
 * left out where a superuser owns it: a superuser installs an extension, or
 * the bootstrap superuser does for a role trusted with one, and owns what it
 * creates. Belonging to an extension is not enough on its own, because whoever
 * owns an extension can add a function or operator of their own to it with
 * ALTER EXTENSION ... ADD.
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
       WHERE n.nspname IN ${CHECKED_SCHEMAS}
       UNION ALL
       SELECT 'an operator', o.oid::regoperator::text, o.oprowner,
              o.oid, 'pg_operator'::regclass
       FROM pg_operator o
       JOIN pg_namespace n ON n.oid = o.oprnamespace
       WHERE n.nspname IN ${CHECKED_SCHEMAS}
     ) AS objects
     WHERE objects.owner <> ${RUNNING_ROLE}
       AND NOT (
         EXISTS (SELECT FROM pg_roles r
                 WHERE r.oid = objects.owner AND r.rolsuper)
         AND EXISTS (SELECT FROM pg_depend d
                     WHERE d.classid = objects.catalog
                       AND d.objid = objects.object
                       AND d.deptype = 'e')
       )
     ORDER BY objects.name`,
  );
  return rows.map(
    (row) =>
      `${row.name} is ${row.kind} that ${row.owner} owns, not the schema owner.`,
  );
}

/**
 * public or pgboss, or a schema named after the role this runs as, where a
 * role other than that one owns it.
 *
 * A schema's owner can create in it whatever its grants say, and drop or
 * replace what others put there, so one of another role's is the CREATE that
 * createFindings looks for and more. Nothing Open BRF runs creates either
 * schema as another role, and the schema-owner service hands both to the
 * owner, but an instance on a shared server does not run that service. The
 * one named after the owner is not Open BRF's at all. pg_database_owner, which
 * owns public in a database created on PostgreSQL 15 or later, stands for
 * whoever owns the database, which databaseFindings requires to be the role
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
     WHERE n.nspname IN ${CHECKED_SCHEMAS}
       AND n.nspowner NOT IN ${TRUSTED_ROLES}
     ORDER BY n.nspname`,
  );
  return rows.map(
    (row) => `${row.schema} belongs to ${row.owner}, not the schema owner.`,
  );
}

/**
 * Roles other than the one this runs as, or PUBLIC, that hold CREATE in public
 * or pgboss, or in a schema named after that role, or that the owner's default
 * privileges give it to in every schema the owner creates.
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
     WHERE n.nspname IN ${CHECKED_SCHEMAS}
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
 * The database, where a role other than the one this runs as owns it, and the
 * roles other than that one, or PUBLIC, that hold CREATE on it.
 *
 * The database's owner owns public through pg_database_owner, can grant
 * CREATE on the database, and is the one role that can close the database to
 * the other roles on the server, which the runtime role's hardening does after
 * the migrations. That hardening also accepts a member of the role that owns
 * the database; this asks for the role itself, before anything runs.
 *
 * CREATE on the database lets a role create a schema: one named after the
 * owner comes before public on the owner's search_path, and is checked as
 * public is, but whatever the role leaves elsewhere is not. It also lets a
 * role install a trusted extension and own it. A superuser can do all of that
 * whatever the grants say, so a grant to one is left out.
 */
async function databaseFindings(db) {
  const owners = await catalogRows(
    db,
    `SELECT quote_ident(d.datname) AS database,
            quote_ident(pg_get_userbyid(d.datdba)) AS owner
     FROM pg_database d
     WHERE d.datname = current_database()
       AND d.datdba <> ${RUNNING_ROLE}`,
  );
  const creates = await catalogRows(
    db,
    `SELECT ${GRANTEE} AS grantee, quote_ident(d.datname) AS database
     FROM pg_database d
     CROSS JOIN LATERAL aclexplode(d.datacl) AS g
     WHERE d.datname = current_database()
       AND g.privilege_type = 'CREATE'
       AND g.grantee NOT IN (SELECT r.oid FROM pg_roles r
                             WHERE r.rolname = current_user OR r.rolsuper)
     ORDER BY 1`,
  );
  return [
    ...owners.map(
      (row) =>
        `The database ${row.database} belongs to ${row.owner}, not the ` +
        "schema owner.",
    ),
    ...creates.map(
      (row) => `${row.grantee} holds CREATE on the database ${row.database}.`,
    ),
  ];
}

/**
 * Roles other than a superuser that are members of the role this runs as,
 * directly or through another role, with whatever options; and, as `trusted`,
 * the one OWNER_DB_ADMIN names, where it holds the ADMIN OPTION on the owner
 * it got by creating it and can neither inherit the owner's privileges nor SET
 * ROLE to it.
 *
 * A member that inherits the owner's privileges or can SET ROLE to it can do
 * whatever the owner can, and what it does is the owner's: replace a guard
 * function, drop a trigger or switch one off, or put a function where a
 * migration will call it, all of it owned by the owner, so that nothing the
 * other checks look at is another role's. A member that holds ADMIN OPTION
 * can grant itself either at any time, and so can a role that can act as that
 * member. Any other member can be let act as the owner by a role that holds
 * ADMIN OPTION on it.
 *
 * A role that creates the owner without being a superuser gets ADMIN OPTION
 * on it on PostgreSQL 16 and later, granted in the bootstrap superuser's name,
 * and only a superuser can revoke it. On a managed server, where nobody holds
 * a superuser, OWNER_DB_ADMIN names that role, as a decision to trust it with
 * the owner's privileges: this check cannot tell what it did with them. The
 * trust holds for that grant, and not for one another role made, or for a
 * membership through another role. pg_has_role calls any membership MEMBER,
 * and before 16 every member could SET ROLE, which it calls MEMBER there too.
 */
async function memberFindings(db) {
  /**
   * Whether the role `member` can act as `role`, both oids: inherit its
   * privileges, or SET ROLE to it.
   */
  const actsAs = (member, role) =>
    `(pg_has_role(${member}, ${role}, 'USAGE')
      OR pg_has_role(${member}, ${role},
                     CASE WHEN current_setting('server_version_num')::int
                               >= 160000
                          THEN 'SET' ELSE 'MEMBER' END))`;
  const rows = await catalogRows(
    db,
    `SELECT r.rolname AS name,
            quote_ident(r.rolname) AS member,
            quote_ident(current_user) AS owner,
            ${actsAs("r.oid", RUNNING_ROLE)} AS acts,
            EXISTS (SELECT FROM pg_auth_members m
                    WHERE m.roleid = ${RUNNING_ROLE}
                      AND m.admin_option
                      AND (m.member = r.oid
                           OR ${actsAs("r.oid", "m.member")})) AS administers,
            EXISTS (SELECT FROM pg_auth_members m
                    WHERE m.roleid = ${RUNNING_ROLE}
                      AND m.member = r.oid
                      AND m.admin_option
                      -- The bootstrap superuser, always oid 10.
                      AND m.grantor = 10) AS creator
     FROM pg_roles r
     WHERE r.rolname <> current_user
       AND NOT r.rolsuper
       AND pg_has_role(r.oid, ${RUNNING_ROLE}, 'MEMBER')
     ORDER BY r.rolname`,
  );
  const admin = process.env.OWNER_DB_ADMIN;
  const trusted = rows.find(
    (row) => row.name === admin && row.creator && !row.acts,
  );
  return {
    findings: rows
      .filter((row) => row !== trusted)
      .map((row) => {
        if (row.acts) {
          return `${row.member} can act as the schema owner ${row.owner}.`;
        }
        return row.administers
          ? `${row.member} is a member of the schema owner ${row.owner}, ` +
              "and can grant itself the owner's privileges."
          : `${row.member} is a member of the schema owner ${row.owner}, ` +
              "and a role holding ADMIN OPTION on the owner can let it act " +
              "as it.";
      }),
    trusted: trusted?.member,
  };
}

/**
 * Settings stored for the role this runs as, in every database or in this
 * one, and a search_path stored for this database.
 *
 * Each applies to every session of the owner's that does not set it, the
 * migrations' and pg-boss's among them, and the owner can store either
 * itself. A search_path decides which function a name in their SQL resolves
 * to, and one that names a schema the owner made puts it beyond the schemas
 * the other checks look at. Open BRF stores no setting for the owner; a
 * database's other settings are its administrator's to choose.
 */
async function settingFindings(db) {
  const rows = await catalogRows(
    db,
    `SELECT CASE WHEN s.setrole = 0
                 THEN format('The database %I', current_database())
                 WHEN s.setdatabase = 0
                 THEN format('The schema owner %I', current_user)
                 ELSE format('The schema owner %I, in the database %I,',
                             current_user, current_database()) END AS "for",
            string_agg(c.setting, ', ' ORDER BY c.setting) AS settings
     FROM pg_db_role_setting s
     CROSS JOIN LATERAL unnest(s.setconfig) AS c(setting)
     WHERE (s.setrole = ${RUNNING_ROLE}
            AND s.setdatabase IN (0, (SELECT oid FROM pg_database
                                      WHERE datname = current_database())))
        OR (s.setrole = 0
            AND s.setdatabase = (SELECT oid FROM pg_database
                                 WHERE datname = current_database())
            AND lower(split_part(c.setting, '=', 1)) = 'search_path')
     GROUP BY s.setrole, s.setdatabase
     ORDER BY s.setrole, s.setdatabase`,
  );
  return rows.map(
    (row) => `${row.for} has the stored setting ${row.settings}.`,
  );
}

/**
 * Stops the deploy while a trigger on a table in public or pgboss is not one
 * Open BRF created, is missing or switched off, or calls a function that is
 * not as Open BRF wrote it, or while a role other than a table's owner can
 * replace one. Also while a function or operator there belongs to a role other
 * than the schema owner, or while such a role owns either schema or can create
 * in it, owns the database or can create in it, or is a member of the owner,
 * or while a setting is stored for the owner. Also while the record of the
 * migrations that have run cannot be read as it is.
 *
 * `stage` names what stops, in the message: "the deploy" before the
 * migrations, "the install" in the job schema install. What passed is
 * returned for the message that says so: the guard triggers looked for, the
 * migrations that have run, and the member OWNER_DB_ADMIN trusts, if any.
 *
 * Refuses rather than repairs. A trigger that is not the one created, a
 * function or operator of another role's, or a role that could have put either
 * there, means something may have written the archive's tables or the job
 * queue with a guard off, or run code as the owner, and only a person can find
 * out what.
 */
export async function refuseUnsafeTriggers(db, stage) {
  const { applied, finding: history } = await appliedMigrations(db);
  const triggers = await triggerFindings(db, applied);
  const grants = await grantFindings(db);
  const objects = await objectFindings(db);
  const owners = await schemaOwnerFindings(db);
  const creates = await createFindings(db);
  const databases = await databaseFindings(db);
  const { findings: members, trusted } = await memberFindings(db);
  const settings = await settingFindings(db);
  const findings = [
    ...(history === undefined ? [] : [history]),
    ...triggers,
    ...grants,
    ...objects,
    ...owners,
    ...creates,
    ...databases,
    ...members,
    ...settings,
  ];
  if (findings.length === 0) {
    return {
      guards: [...TRIGGER_MIGRATIONS.values()].filter((migration) =>
        applied.has(migration),
      ).length,
      migrations: applied.size,
      trusted,
    };
  }
  for (const finding of findings) {
    console.error(finding);
  }
  if (history !== undefined) {
    console.error(
      "The check reads public._prisma_migrations to know which guards the " +
        "migrations have created, and prisma migrate deploy creates it as a " +
        "table of the schema owner's that applies no policy to its owner " +
        "and has neither a parent nor a child. Find out who changed it and " +
        "why, and whether rows were taken out of it. Then, as a superuser, " +
        "hand it to the schema owner with ALTER TABLE ... OWNER TO, or, as " +
        "the schema owner, drop its policies (\\d public._prisma_migrations " +
        "in psql lists them, and its parent and children) and run ALTER " +
        "TABLE public._prisma_migrations NO FORCE ROW LEVEL SECURITY, " +
        "DISABLE ROW LEVEL SECURITY. Copy the migrations' rows in a child " +
        "back into it, then run ALTER TABLE <child> NO INHERIT " +
        "public._prisma_migrations, or ALTER TABLE " +
        "public._prisma_migrations NO INHERIT <parent>.",
    );
  }
  if (triggers.length > 0) {
    console.error(
      "A trigger runs its function as whoever writes its table, the schema " +
        "owner during the migrations among them, and a guard that was " +
        "replaced, dropped or switched off, or whose function was rewritten, " +
        "no longer guards. Find out who changed the triggers named above: " +
        "CREATE OR REPLACE TRIGGER asks only for the TRIGGER privilege on a " +
        "table, and nothing Open BRF runs grants it; the rest takes the " +
        "schema owner's own privileges, or a role that can act as it. Then, " +
        "as the schema owner, put each trigger and function back from the " +
        "migration under prisma/migrations that creates it, or from " +
        "scripts/install-job-schema.mjs for pgboss.queue, switch a trigger " +
        "back on with ALTER TABLE ... ENABLE TRIGGER, and drop any you do " +
        "not recognise.",
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
        "a function or operator in public or pgboss, or in a schema named " +
        "after the schema owner, which then runs as the " +
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
        "then look at what that role has put there. Open BRF uses no schema " +
        "named after the schema owner: drop one once you have looked.",
    );
  }
  if (creates.length > 0) {
    console.error(
      "A role holding CREATE in public or pgboss, or in a schema named after " +
        "the schema owner, can put a function or operator there for the " +
        "schema owner to run. PostgreSQL before 15 " +
        "gave CREATE in public to PUBLIC, and a database restored from a dump " +
        "of one keeps the grant. As the schema's owner, REVOKE CREATE ON " +
        "SCHEMA from each role named above, in each schema named. A grant " +
        "that comes from default privileges (\\ddp in psql) is revoked " +
        "there, with ALTER DEFAULT PRIVILEGES, or the next schema the owner " +
        "creates gets it again.",
    );
  }
  if (databases.length > 0) {
    console.error(
      "The database's owner owns public on PostgreSQL 15 and later, and only " +
        "it can close the database to the other roles on the server. A role " +
        "holding CREATE on the database can create a schema named after the " +
        "schema owner, which comes before public on its search_path, and " +
        "install a trusted extension and own it. As a superuser, hand the " +
        "database to the schema owner with ALTER DATABASE ... OWNER TO. As " +
        "the role that granted it, REVOKE CREATE ON DATABASE from each role " +
        "named above, then look at the schemas and extensions it created " +
        "(\\dn and \\dx in psql).",
    );
  }
  if (members.length > 0) {
    console.error(
      "A role that can act as the schema owner can do whatever the owner " +
        "can: rewrite a guard function, drop a trigger or switch one off, or " +
        "create a function for a migration to call, and what it creates " +
        "belongs to the owner. A member that holds only ADMIN OPTION on the " +
        "owner can grant itself the same at any time, and a role holding " +
        "ADMIN OPTION can grant it to any other member. Find out who made " +
        "each role named above a member and what it did, then, as a " +
        "superuser or the role that granted it, REVOKE the schema owner FROM " +
        "that role, or from the role it is a member through (\\du in psql). " +
        "Where the only such role is the administrator that created the " +
        "owner, holding only the ADMIN OPTION it got by doing so, and no " +
        "superuser can revoke that, as on a managed server, OWNER_DB_ADMIN " +
        "can name it: a decision to trust that role with the owner's " +
        "privileges. A role that is a member of it is still refused.",
    );
  }
  if (settings.length > 0) {
    console.error(
      "A setting stored for the schema owner applies to every session of " +
        "its, the migrations' and pg-boss's among them, and a search_path " +
        "decides which function a name in their SQL resolves to. Open BRF " +
        "stores none. Find out who stored each one named above and why, " +
        "then, as the schema owner, take it away with ALTER ROLE ... RESET, " +
        "or ALTER ROLE ... IN DATABASE ... RESET, or ALTER DATABASE ... " +
        "RESET search_path (\\drds in psql lists them).",
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
  let passed;
  try {
    passed = await refuseUnsafeTriggers(
      { executeSql: (text) => client.query(text) },
      "the deploy",
    );
  } finally {
    await client.end();
  }
  const total = TRIGGER_MIGRATIONS.size;
  const guards =
    passed.guards === 0
      ? "No migration that creates a guard trigger on the application's " +
        "tables has run yet, so none was looked for."
      : `${passed.migrations} migrations have run, and the guard triggers ` +
        `they created on the application's tables, ${passed.guards} of the ` +
        `${total}, are all there.` +
        (passed.guards < total
          ? ` The other ${total - passed.guards} come with migrations still ` +
            "to run."
          : "");
  const members =
    passed.trusted === undefined
      ? ""
      : ` and ${passed.trusted}, which OWNER_DB_ADMIN trusts: it cannot act ` +
        "as the owner now, but can grant itself the owner's privileges";
  console.log(
    `${guards} Every trigger on the tables in public and pgboss is one Open ` +
      "BRF creates, fires as created, and calls a function as Open BRF wrote " +
      "it. The one on pgboss.queue is not required here: the job schema " +
      "install puts it back and checks it again. No role but a table's " +
      "owner holds TRIGGER on one. No role but the schema owner or a " +
      "superuser owns public, pgboss or a schema named after the owner, owns " +
      "a function or operator in them, or holds CREATE in them or on the " +
      "database. The schema owner owns the database and has no stored " +
      "settings, the database stores no search_path, and no role is a " +
      `member of the owner but a superuser${members}. A superuser can still ` +
      "act as it.",
  );
}

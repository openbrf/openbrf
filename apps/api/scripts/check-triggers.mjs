/**
 * Checks the triggers on the application's tables and the job schema's, and
 * who can replace them, before anything runs as the schema owner.
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
 * The triggers on the tables in public and pgboss, each with its definition and
 * whether its table's owner owns the function it calls.
 *
 * pg_get_triggerdef qualifies a name only where the search path would not find
 * it, so the path is pinned to pg_catalog for this one query: SET LOCAL in the
 * implicit transaction a query of several statements runs in, which the pool
 * cannot split across connections or leave behind on one.
 */
export async function currentTriggers(db) {
  const results = await db.executeSql(
    `SET LOCAL search_path = pg_catalog;
     SELECT format('%I.%I', n.nspname, c.relname) AS "table",
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
  return results.at(-1).rows;
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
  const grantee = `CASE WHEN g.grantee = 0 THEN 'PUBLIC'
                        ELSE quote_ident(pg_get_userbyid(g.grantee)) END`;
  const tables = await db.executeSql(
    `SELECT ${grantee} AS grantee,
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
  const defaults = await db.executeSql(
    `SELECT ${grantee} AS grantee,
            string_agg(CASE WHEN d.defaclnamespace = 0 THEN 'every schema'
                            ELSE quote_ident(n.nspname) END, ' and in '
                       ORDER BY n.nspname NULLS FIRST) AS schemas
     FROM pg_default_acl d
     LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     CROSS JOIN LATERAL aclexplode(d.defaclacl) AS g
     WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND d.defaclobjtype = 'r'
       AND (d.defaclnamespace = 0 OR n.nspname IN ('public', 'pgboss'))
       AND g.grantee <> d.defaclrole
       AND g.privilege_type = 'TRIGGER'
     GROUP BY g.grantee
     ORDER BY 1`,
  );
  return [
    ...tables.rows.map(
      (row) => `${row.grantee} holds TRIGGER on ${row.tables}.`,
    ),
    ...defaults.rows.map(
      (row) =>
        `${row.grantee} is given TRIGGER by default on the tables the schema ` +
        `owner creates in ${row.schemas}.`,
    ),
  ];
}

/**
 * Stops the deploy while a trigger on a table in public or pgboss is not one
 * Open BRF created, or while a role other than a table's owner can replace one.
 *
 * `stage` names what stops, in the message: "the deploy" before the
 * migrations, "the install" in the job schema install.
 *
 * Refuses rather than repairs. A trigger that is not the one created, or a
 * role that could have changed it, means something may have written the
 * archive's tables or the job queue with a guard off, or run code as the
 * owner, and only a person can find out what.
 */
export async function refuseUnsafeTriggers(db, stage) {
  const triggers = await triggerFindings(db);
  const grants = await grantFindings(db);
  if (triggers.length === 0 && grants.length === 0) {
    return;
  }
  for (const finding of [...triggers, ...grants]) {
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
  console.log("The triggers are the ones Open BRF creates.");
}

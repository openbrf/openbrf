import { PrismaPg } from "@prisma/adapter-pg";

import { applicationDatabaseUrl, type Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";

/**
 * Whether the connection the application holds is the constrained role, asked
 * of the database rather than read off the configuration.
 *
 * DATABASE_URL_RUNTIME being set says nothing about the role it names. An
 * operator who manages that role themselves writes the URL by hand, and one
 * that names the schema owner - or a superuser - starts an application that
 * can switch off the triggers keeping the member register and the audit log
 * append-only, while everything about the deployment still reads as if it
 * could not. The database is the only party that knows which role this is, so
 * it is asked, once, before the application serves anything.
 *
 * The questions are the ones prisma/sql/harden-runtime-role.sql answers when it
 * constrains the runtime role, asked the other way round: attributes that
 * override every privilege; ownership of anything in the application's
 * schemas - a table, a function or a type - or membership of the owning role,
 * which confers the same; membership of any role at all, whose privileges no
 * revoke on the runtime role reaches; CREATE in the application's schemas,
 * which is the way to ownership; and every privilege that script revokes on
 * the statutory archive, the migration history and the job schema's version.
 */

/** What a Prisma client, or a transaction on one, offers for a raw read. */
export interface RawQueryable {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

type RoleFacts = {
  role: string;
  superuser: boolean;
  attributes: string[];
  ownsDatabase: boolean;
  ownsSchema: boolean;
  ownsRelation: boolean;
  ownsRoutineOrType: boolean;
  memberOf: string[];
  createsInSchema: boolean;
  rewritableArchive: string[];
  writesMigrationHistory: boolean;
  writesJobSchemaVersion: boolean;
};

/**
 * The statutory tables and what prisma/sql/harden-runtime-role.sql takes away
 * on each. TRUNCATE is listed everywhere because the script revokes it on every
 * table in the schema. A transfer and a lien note keep UPDATE on purpose: a
 * lien is released and a mis-keyed transfer corrected.
 *
 * Exported so the integration suite can grant each of these in turn and see
 * the start refuse it.
 */
export const ARCHIVE_REVOKES: readonly {
  readonly table: string;
  readonly privileges: readonly string[];
}[] = [
  {
    table: "member_register_entry",
    privileges: ["UPDATE", "DELETE", "TRUNCATE"],
  },
  { table: "audit_log_entry", privileges: ["UPDATE", "DELETE", "TRUNCATE"] },
  { table: "termination", privileges: ["UPDATE", "DELETE", "TRUNCATE"] },
  { table: "transfer_reversal", privileges: ["UPDATE", "DELETE", "TRUNCATE"] },
  {
    table: "register_report_obligation",
    privileges: ["UPDATE", "DELETE", "TRUNCATE"],
  },
  { table: "transfer", privileges: ["DELETE", "TRUNCATE"] },
  { table: "lien_note", privileges: ["DELETE", "TRUNCATE"] },
];

/**
 * The names of the statutory tables the role holds a revoked privilege on.
 * Built from the constants above, never from anything the database or the
 * configuration says, so the interpolation is not a way in. A table that does
 * not exist yet answers NULL, which counts as no privilege.
 */
const REWRITABLE_ARCHIVE = `array_remove(ARRAY[${ARCHIVE_REVOKES.map(
  ({ table, privileges }) =>
    `CASE WHEN coalesce(has_table_privilege(to_regclass('public.${table}'), '${privileges.join(", ")}'), false) THEN '${table}' END`,
).join(",\n    ")}], NULL)`;

const ROLE_FACTS = `
SELECT
  current_user::text AS role,
  r.rolsuper AS superuser,
  array_remove(ARRAY[
    CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END,
    CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN r.rolreplication THEN 'REPLICATION' END
  ], NULL) AS attributes,
  EXISTS (
    SELECT 1 FROM pg_database d
    WHERE d.datname = current_database()
      AND pg_has_role(current_user, d.datdba, 'MEMBER')
  ) AS "ownsDatabase",
  EXISTS (
    SELECT 1 FROM pg_namespace n
    WHERE n.nspname IN ('public', 'pgboss')
      AND pg_has_role(current_user, n.nspowner, 'MEMBER')
  ) AS "ownsSchema",
  EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'pgboss')
      AND pg_has_role(current_user, c.relowner, 'MEMBER')
  ) AS "ownsRelation",
  -- A function's owner can drop it, and with CASCADE every trigger that runs
  -- it; a type's owner can drop the columns built on it. A table's row type is
  -- left out, being the table's and already asked about above.
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'pgboss')
      AND pg_has_role(current_user, p.proowner, 'MEMBER')
  ) OR EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'pgboss')
      AND t.typrelid = 0
      AND pg_has_role(current_user, t.typowner, 'MEMBER')
  ) AS "ownsRoutineOrType",
  -- Every role granted to this one, whatever it is: its privileges are the
  -- granted role's, so nothing the hardening revokes reaches them.
  array(
    SELECT granted.rolname::text
    FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid
    WHERE m.member = r.oid
    ORDER BY granted.rolname
  ) AS "memberOf",
  EXISTS (
    SELECT 1 FROM pg_namespace n
    WHERE n.nspname IN ('public', 'pgboss')
      AND has_schema_privilege(n.oid, 'CREATE')
  ) AS "createsInSchema",
  ${REWRITABLE_ARCHIVE} AS "rewritableArchive",
  coalesce(has_table_privilege(to_regclass('public._prisma_migrations'), 'INSERT, UPDATE, DELETE, TRUNCATE'), false)
    AS "writesMigrationHistory",
  -- The version column alone: the application stamps the row's other columns
  -- as pg-boss's maintenance runs. Asked of the column, so a grant on that one
  -- column is found as well as one on the table.
  coalesce(has_table_privilege(to_regclass('pgboss.version'), 'INSERT, DELETE, TRUNCATE'), false)
    OR coalesce(has_column_privilege(to_regclass('pgboss.version'), 'version', 'UPDATE'), false)
    AS "writesJobSchemaVersion"
FROM pg_roles r
WHERE r.rolname = current_user
`;

/**
 * Every reason the connected role is not the constrained one, or an empty list
 * when it is.
 *
 * Each reason names what was found and never anything from the connection
 * string: this runs at boot, so what it says ends up in the container's log.
 */
export async function runtimeRoleProblems(
  client: RawQueryable,
): Promise<string[]> {
  const [facts] = await client.$queryRawUnsafe<RoleFacts[]>(ROLE_FACTS);
  if (facts === undefined) {
    return ["the connected role is not in pg_roles"];
  }

  const problems: string[] = [];
  if (facts.superuser) {
    problems.push(`${facts.role} is a superuser`);
  }
  if (facts.attributes.length > 0) {
    problems.push(`${facts.role} has ${facts.attributes.join(", ")}`);
  }
  if (facts.ownsDatabase) {
    problems.push(`${facts.role} owns the database`);
  }
  if (facts.ownsSchema) {
    problems.push(`${facts.role} owns the public or the pgboss schema`);
  }
  if (facts.ownsRelation) {
    problems.push(`${facts.role} owns tables in the application's schemas`);
  }
  if (facts.ownsRoutineOrType) {
    problems.push(
      `${facts.role} owns functions or types in the application's schemas`,
    );
  }
  if (facts.memberOf.length > 0) {
    problems.push(
      `${facts.role} is a member of ${facts.memberOf.join(", ")}, whose privileges the hardening cannot take away`,
    );
  }
  if (facts.createsInSchema) {
    problems.push(
      `${facts.role} can create objects in the public or the pgboss schema`,
    );
  }
  if (facts.rewritableArchive.length > 0) {
    problems.push(
      `${facts.role} can rewrite or delete statutory records in ${facts.rewritableArchive.join(", ")}`,
    );
  }
  if (facts.writesMigrationHistory) {
    problems.push(`${facts.role} can write the migration history`);
  }
  if (facts.writesJobSchemaVersion) {
    problems.push(`${facts.role} can write the job schema's version`);
  }
  return problems;
}

/**
 * Refuses a production start whose connection is not the constrained role.
 *
 * Called first thing at boot, before a plugin is loaded or a module is built:
 * the job queue and the feature modules start working as they initialise, and
 * none of that may happen on a connection that turns out to be the owner's.
 * The connection is its own and closed again, so nothing is left open on it
 * whichever way the answer goes. Outside production it asks nothing, because a
 * development instance runs on the owner's connection on purpose.
 */
export async function assertConstrainedRuntimeRole(env: Env): Promise<void> {
  if (env.NODE_ENV !== "production") {
    return;
  }

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: applicationDatabaseUrl(env) }),
  });
  let problems: string[];
  try {
    problems = await runtimeRoleProblems(client);
  } finally {
    await client.$disconnect();
  }

  if (problems.length > 0) {
    throw new Error(
      "The application's database connection is not the constrained runtime " +
        `role: ${problems.join("; ")}. Point DATABASE_URL_RUNTIME at a role ` +
        "that owns nothing and holds only what " +
        "prisma/sql/harden-runtime-role.sql grants the runtime role.",
    );
  }
}

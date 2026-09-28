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
 * constrains openbrf_app, asked the other way round: attributes that override
 * every privilege, ownership (or membership of the owning role, which confers
 * the same), and the privileges that script revokes on the statutory archive
 * and the migration history.
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
  rewritesArchive: boolean;
  writesMigrationHistory: boolean;
};

/**
 * Asked of the member register and the audit log. The full list of statutory
 * tables is the hardening script's; these two stand for it, because a
 * connection that can rewrite either is not the constrained role whatever else
 * it can do.
 */
const ARCHIVE_WRITE = "UPDATE, DELETE, TRUNCATE";

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
  coalesce(has_table_privilege(to_regclass('public.member_register_entry'), '${ARCHIVE_WRITE}'), false)
    OR coalesce(has_table_privilege(to_regclass('public.audit_log_entry'), '${ARCHIVE_WRITE}'), false)
    AS "rewritesArchive",
  coalesce(has_table_privilege(to_regclass('public._prisma_migrations'), 'INSERT, UPDATE, DELETE, TRUNCATE'), false)
    AS "writesMigrationHistory"
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
  if (facts.rewritesArchive) {
    problems.push(
      `${facts.role} can rewrite the member register or the audit log`,
    );
  }
  if (facts.writesMigrationHistory) {
    problems.push(`${facts.role} can write the migration history`);
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
        "prisma/sql/harden-runtime-role.sql grants openbrf_app.",
    );
  }
}

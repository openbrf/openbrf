-- Creates the schema owner and gives it the database.
--
-- Three roles, and this file is where the first gives way to the second:
--
--   openbrf        the superuser the database image creates. Used by the
--                  database container and by this script, and by nothing
--                  else: the application's container never holds its
--                  password, and neither does the migrate service's.
--   openbrf_owner  owns the database, its schemas and every table in them,
--                  and runs migrations, the job schema install and the
--                  runtime role's hardening. Not a superuser. OWNER_DB_USER
--                  names it something else.
--   openbrf_app    the application's connection. Owns nothing
--                  (apps/api/prisma/sql/harden-runtime-role.sql).
--                  RUNTIME_DB_ROLE names it something else.
--
-- Owning the tables is all migrations need. A superuser can also run programs
-- on the database host and read its files, and nothing that applies a
-- migration has any use for either, so the role that does is not one.
--
-- CREATEROLE is the one attribute it holds, because it creates the runtime
-- role and sets its password on every start. On PostgreSQL 16 and later that
-- reaches only the roles it created or was given ADMIN OPTION on, and it
-- cannot hand out SUPERUSER, BYPASSRLS or REPLICATION; before 16 it could
-- grant itself far more, so this script refuses an older server.
--
-- Run as the superuser by the schema-owner service in docker-compose.prod.yml,
-- on every `up` and before the migrate service. Idempotent: on a new instance
-- it creates the owner and hands it an empty database; on an instance
-- installed before the owner existed it also moves everything the superuser
-- owns in the application's schemas over to the owner, and revokes every role
-- the runtime role was made a member of; after that it changes nothing but
-- the owner's password, which it sets from the env file each time.
--
-- An instance on a database server it does not run, where no superuser is at
-- hand, has its owner created by whoever administers that server
-- (docs/deployment.md, "Several instances on one database server").
--
-- The password is read from OWNER_DB_PASSWORD in the environment, never from
-- an argument, for the same reason as in harden-runtime-role.sql. The two
-- names come from OWNER_DB_USER and RUNTIME_DB_ROLE, which
-- docker/schema-owner.mjs has already checked are plain identifiers, and are
-- quoted wherever they are used.

\set ON_ERROR_STOP on

\getenv owner_password OWNER_DB_PASSWORD
\if :{?owner_password}
\else
\set owner_password ''
\endif

\getenv owner_role OWNER_DB_USER
\if :{?owner_role}
\else
\set owner_role ''
\endif
SELECT coalesce(nullif(:'owner_role', ''), 'openbrf_owner') AS owner_role
\gset

\getenv app_role RUNTIME_DB_ROLE
\if :{?app_role}
\else
\set app_role ''
\endif
SELECT coalesce(nullif(:'app_role', ''), 'openbrf_app') AS app_role
\gset

BEGIN;

-- The block below cannot see psql's variables: psql does not substitute
-- inside a dollar-quoted body. It reads the owner's name from this setting,
-- which lasts until the transaction ends.
SELECT set_config('openbrf.owner_role', :'owner_role', true) AS ignored
\gset

SELECT $sql$DO $body$ BEGIN
  RAISE EXCEPTION 'OWNER_DB_PASSWORD is not set in the schema-owner container. Set it in the env file and run `up -d` again.';
END $body$$sql$
WHERE coalesce(:'owner_password', '') = ''
\gexec

SELECT $sql$DO $body$ BEGIN
  RAISE EXCEPTION 'PostgreSQL 16 or later is required: before 16, CREATEROLE lets the schema owner grant itself membership of any role but a superuser, which is what this script exists to take away.';
END $body$$sql$
WHERE current_setting('server_version_num')::int < 160000
\gexec

-- The ALTER ROLE below takes SUPERUSER away. Pointed at the role running this
-- script, or at another superuser, it would demote the one role that can put
-- the server right, so the script refuses instead. The message is passed to
-- RAISE as a parameter, so a name cannot turn into a placeholder.
SELECT format($sql$DO $body$ BEGIN RAISE EXCEPTION USING MESSAGE = %L; END $body$$sql$,
  format('OWNER_DB_USER names %I, which is a superuser. The schema owner has to be a role of its own that is not one: leave OWNER_DB_USER empty for openbrf_owner, or name a new role.',
    rolname))
FROM pg_roles
WHERE rolname = :'owner_role'
  AND (rolsuper OR rolname = current_user)
\gexec

SELECT format($sql$DO $body$ BEGIN RAISE EXCEPTION USING MESSAGE = %L; END $body$$sql$,
  'OWNER_DB_USER and RUNTIME_DB_ROLE name the same role. The application needs a role of its own: the owner can disable the triggers that keep the member register and the audit log append-only.')
WHERE :'owner_role' = :'app_role'
\gexec

SELECT format(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_role')
      THEN 'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L'
    ELSE 'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L'
  END,
  :'owner_role',
  :'owner_password')
\gexec

-- The database, and with it the public schema, which PostgreSQL 15 and later
-- give to whoever owns the database.
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'owner_role')
\gexec

-- Everything else in the application's two schemas. Empty on a first start;
-- on an instance that migrated as the superuser, every table, sequence, type
-- and function it created. Indexes, and sequences that belong to a column,
-- follow their table and cannot be moved on their own, and nothing an
-- extension installed is touched.
--
-- Anything the runtime role owns there is moved too. It should own nothing,
-- and harden-runtime-role.sql refuses to run while it does; an earlier release
-- let it create objects in pgboss, so this is where those are put right.
DO $body$
DECLARE
  owner_role text := current_setting('openbrf.owner_role');
  target record;
BEGIN
  FOR target IN
    SELECT format('ALTER %s %s OWNER TO %I', owned.kind, owned.name, owner_role) AS statement
    FROM (
      SELECT 'SCHEMA' AS kind, quote_ident(n.nspname) AS name, n.nspowner AS owner,
             n.oid AS object, 'pg_namespace'::regclass AS catalog
      FROM pg_namespace n
      WHERE n.nspname IN ('public', 'pgboss')
      UNION ALL
      SELECT CASE c.relkind
               WHEN 'v' THEN 'VIEW'
               WHEN 'm' THEN 'MATERIALIZED VIEW'
               WHEN 'S' THEN 'SEQUENCE'
               WHEN 'f' THEN 'FOREIGN TABLE'
               ELSE 'TABLE'
             END,
             format('%I.%I', n.nspname, c.relname), c.relowner,
             c.oid, 'pg_class'::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'pgboss')
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND NOT (
          c.relkind = 'S' AND EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass
              AND d.objid = c.oid
              AND d.refclassid = 'pg_class'::regclass
              AND d.deptype IN ('a', 'i')
          )
        )
      UNION ALL
      SELECT CASE p.prokind
               WHEN 'p' THEN 'PROCEDURE'
               WHEN 'a' THEN 'AGGREGATE'
               ELSE 'FUNCTION'
             END,
             p.oid::regprocedure::text, p.proowner,
             p.oid, 'pg_proc'::regclass
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'pgboss')
      UNION ALL
      SELECT CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
             format('%I.%I', n.nspname, t.typname), t.typowner,
             t.oid, 'pg_type'::regclass
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname IN ('public', 'pgboss')
        AND (
          t.typtype IN ('e', 'd', 'r')
          OR (t.typtype = 'c'
              AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')
        )
    ) AS owned
    JOIN pg_roles r ON r.oid = owned.owner
    WHERE r.rolname NOT IN (owner_role, 'pg_database_owner')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = owned.catalog
          AND d.objid = owned.object
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE target.statement;
  END LOOP;
END
$body$;

-- A runtime role the superuser created earlier is not one the owner may
-- alter, and it sets that role's password on every start. ADMIN OPTION is
-- that permission and nothing more: without INHERIT or SET the owner gains
-- none of the runtime role's privileges, which it has no use for anyway.
SELECT format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
              :'app_role', :'owner_role')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    WHERE granted.rolname = :'app_role'
      AND member.rolname = :'owner_role'
      AND m.admin_option
  )
\gexec

-- Any role the runtime role is a member of lends it privileges that
-- harden-runtime-role.sql cannot revoke: they belong to the granted role. Nor
-- can the owner revoke the membership itself, since on PostgreSQL 16 and
-- later only the grantor or a superuser may, so it is done here, and the
-- hardening refuses to run while one is left. CASCADE also takes back anything
-- the runtime role passed on through such a membership.
SELECT format('REVOKE %I FROM %I GRANTED BY %I CASCADE',
              granted.rolname, member.rolname, grantor.rolname)
FROM pg_auth_members m
JOIN pg_roles member ON member.oid = m.member
JOIN pg_roles granted ON granted.oid = m.roleid
JOIN pg_roles grantor ON grantor.oid = m.grantor
WHERE member.rolname = :'app_role'
\gexec

COMMIT;

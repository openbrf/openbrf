-- Creates the schema owner, openbrf_owner, and gives it the database.
--
-- Three roles, and this file is where the first gives way to the second:
--
--   openbrf        the superuser the database image creates. Used by the
--                  database container itself and by nothing else: its
--                  password never leaves that container.
--   openbrf_owner  owns the database, its schemas and every table in them,
--                  and runs migrations, the job schema install and the
--                  runtime role's hardening. Not a superuser.
--   openbrf_app    the application's connection. Owns nothing
--                  (apps/api/prisma/sql/harden-runtime-role.sql).
--
-- Owning the tables is all migrations need. A superuser can also run programs
-- on the database host and read its files, and nothing that applies a
-- migration has any use for either, so the role that does is not one.
--
-- CREATEROLE is the one attribute it holds, because it creates openbrf_app
-- and sets its password on every start. On PostgreSQL 16 and later that
-- reaches only the roles it created or was given ADMIN OPTION on, and it
-- cannot hand out SUPERUSER, BYPASSRLS or REPLICATION; before 16 it could
-- grant itself far more, so this script refuses an older server.
--
-- Run by the database image on the first start of an empty volume, as a file
-- in /docker-entrypoint-initdb.d. On an instance installed before this file
-- existed, run it once by hand - docs/deployment.md, "Upgrading to a separate
-- schema owner":
--
--   docker compose -f docker-compose.prod.yml --env-file .env.production \
--     exec db psql -U openbrf -d openbrf \
--     -f /docker-entrypoint-initdb.d/10-schema-owner.sql
--
-- It is idempotent, and on that second path it also moves everything the
-- superuser owns in the application's schemas over to openbrf_owner.
--
-- The password is read from OWNER_DB_PASSWORD in the environment, never from
-- an argument, for the same reason as in harden-runtime-role.sql.

\set ON_ERROR_STOP on

\getenv owner_password OWNER_DB_PASSWORD
\if :{?owner_password}
\else
\set owner_password ''
\endif

BEGIN;

SELECT $sql$DO $body$ BEGIN
  RAISE EXCEPTION 'OWNER_DB_PASSWORD is not set in the database container. Set it in the env file and recreate the container: docker compose -f docker-compose.prod.yml --env-file .env.production up -d db';
END $body$$sql$
WHERE coalesce(:'owner_password', '') = ''
\gexec

SELECT $sql$DO $body$ BEGIN
  RAISE EXCEPTION 'PostgreSQL 16 or later is required: before 16, CREATEROLE lets the schema owner grant itself membership of any role but a superuser, which is what this script exists to take away.';
END $body$$sql$
WHERE current_setting('server_version_num')::int < 160000
\gexec

SELECT format(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrf_owner')
      THEN 'ALTER ROLE openbrf_owner WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L'
    ELSE 'CREATE ROLE openbrf_owner WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L'
  END,
  :'owner_password')
\gexec

-- The database, and with it the public schema, which PostgreSQL 15 and later
-- give to whoever owns the database.
SELECT format('ALTER DATABASE %I OWNER TO openbrf_owner', current_database())
\gexec

-- Everything else in the application's two schemas. Empty on a first start;
-- on an instance that migrated as the superuser, every table, sequence, type
-- and function it created. Indexes, and sequences that belong to a column,
-- follow their table and cannot be moved on their own, and nothing an
-- extension installed is touched.
--
-- Anything openbrf_app owns there is moved too. It should own nothing, and
-- harden-runtime-role.sql refuses to start while it does; an earlier release
-- let it create objects in pgboss, so this is where those are put right.
DO $body$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT format('ALTER %s %s OWNER TO openbrf_owner', owned.kind, owned.name) AS statement
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
    WHERE r.rolname NOT IN ('openbrf_owner', 'pg_database_owner')
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

-- An openbrf_app the superuser created earlier is not one openbrf_owner may
-- alter, and it sets that role's password on every start. ADMIN OPTION is
-- that permission and nothing more: without INHERIT or SET the owner gains
-- none of openbrf_app's privileges, which it has no use for anyway.
SELECT 'GRANT openbrf_app TO openbrf_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrf_app')
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    WHERE granted.rolname = 'openbrf_app'
      AND member.rolname = 'openbrf_owner'
      AND m.admin_option
  )
\gexec

COMMIT;

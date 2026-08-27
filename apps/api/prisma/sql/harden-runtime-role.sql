-- Defence in depth for the statutory archive (ADR 0002, decision 21).
--
-- The triggers in migration 20260827122611_statutory_append_only_guards stop
-- UPDATE and DELETE for every caller, but a table owner can run
-- ALTER TABLE ... DISABLE TRIGGER and walk straight past them. Prisma commonly
-- runs migrations and the application under the same role, which would leave
-- the guard bypassable by the application itself.
--
-- Production therefore uses two roles:
--
--   openbrf        owns the schema and runs `prisma migrate deploy`
--   openbrf_app    the application connection, owns nothing
--
-- Apply this script once, as the owner, after migrations. Then point the
-- application at openbrf_app via DATABASE_URL_RUNTIME.
--
-- Usage:
--   RUNTIME_DB_PASSWORD="..." psql "$DATABASE_URL" \
--     -f prisma/sql/harden-runtime-role.sql
--
-- The password is read from the environment rather than passed with -v, so it
-- never appears in the process arguments, where any local user can read it out
-- of `ps`. The script wraps itself in a transaction, so there is no half
-- applied state to reason about if a statement fails.

\set ON_ERROR_STOP on

\getenv app_password RUNTIME_DB_PASSWORD
-- psql leaves :'app_password' untouched when the variable was never defined,
-- which reaches PostgreSQL as a syntax error rather than as a clear message.
-- Defining it empty lets the check below speak for itself.
\if :{?app_password}
\else
\set app_password ''
\endif

BEGIN;

-- Raised through \gexec because psql does not substitute inside dollar
-- quoting: the WHERE decides whether any statement is produced at all.
SELECT $sql$DO $body$ BEGIN
  RAISE EXCEPTION 'RUNTIME_DB_PASSWORD is not set. See the usage note at the top of this script.';
END $body$$sql$
WHERE coalesce(:'app_password', '') = ''
\gexec

-- Ownership outranks every privilege granted below, in two different ways.
-- The owner of a table can run ALTER TABLE ... DISABLE TRIGGER whatever its
-- ACL says, and the owner of a schema can run DROP SCHEMA ... CASCADE and take
-- the statutory archive with it. Neither is reachable by any revoke in this
-- file, so if openbrf_app owns anything the script refuses rather than
-- reporting a hardening it did not achieve.
SELECT format($sql$DO $body$ BEGIN
  RAISE EXCEPTION 'openbrf_app owns %s in this database. An owner can disable the statutory triggers, and a schema owner can drop the archive outright, regardless of the privileges this script sets. Reassign them to the schema owner first.';
END $body$$sql$, string_agg(owned.description, ', ' ORDER BY owned.description))
FROM (
  SELECT format('relation %I.%I', n.nspname, c.relname) AS description
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE r.rolname = 'openbrf_app'
  UNION ALL
  SELECT format('schema %I', n.nspname)
  FROM pg_namespace n
  JOIN pg_roles r ON r.oid = n.nspowner
  WHERE r.rolname = 'openbrf_app'
) AS owned
HAVING count(*) > 0
\gexec

-- An openbrf_app that already exists may have been made by hand or by an
-- earlier tool. SUPERUSER or BYPASSRLS on it would ignore every revoke in this
-- file, so the script refuses rather than reporting a hardening it did not
-- achieve. Refusing is deliberate here instead of quietly stripping the
-- attributes: only a superuser may clear SUPERUSER, so a script that tried
-- would fail for the very installers that most need to know, and a runtime
-- role that arrived with those attributes is an anomaly a human should look
-- at rather than something to paper over.
SELECT format($sql$DO $body$ BEGIN
  RAISE EXCEPTION 'Role openbrf_app already exists with %s. This script cannot constrain such a role: those attributes override the privileges it sets. Fix the role, or drop it and run this again.';
END $body$$sql$,
  concat_ws(', ',
    CASE WHEN rolsuper THEN 'SUPERUSER' END,
    CASE WHEN rolbypassrls THEN 'BYPASSRLS' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN rolreplication THEN 'REPLICATION' END))
FROM pg_roles
WHERE rolname = 'openbrf_app'
  AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
\gexec

-- LOGIN is set on both branches, not only on create: PrismaService and
-- JobQueueService both connect as this role through DATABASE_URL_RUNTIME, so
-- an existing NOLOGIN role would leave the application unable to start.
-- Built as a string and run with \gexec for the same reason as above: psql
-- does not substitute :'app_password' inside a dollar-quoted DO body, so the
-- placeholder would reach PostgreSQL literally.
SELECT format(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrf_app')
      THEN 'ALTER ROLE openbrf_app WITH LOGIN PASSWORD %L'
    ELSE 'CREATE ROLE openbrf_app WITH LOGIN PASSWORD %L'
  END,
  :'app_password')
\gexec

-- A role membership carries privileges that the revokes below cannot reach,
-- because they belong to the granted role rather than to openbrf_app.
SELECT format('REVOKE %I FROM openbrf_app', granted.rolname)
FROM pg_auth_members m
JOIN pg_roles member ON member.oid = m.member
JOIN pg_roles granted ON granted.oid = m.roleid
WHERE member.rolname = 'openbrf_app'
\gexec

-- The database name comes from the connection string in the usage note above,
-- so it is read from the connection rather than assumed to be "openbrf".
SELECT format('GRANT CONNECT ON DATABASE %I TO openbrf_app', current_database())
\gexec
GRANT USAGE ON SCHEMA public TO openbrf_app;

-- Ordinary service-tier access.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openbrf_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openbrf_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openbrf_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO openbrf_app;

-- The statutory archive: insert and read only. Revoked after the blanket
-- grant above so the order of this script matters.
-- Schema-qualified: an unqualified name resolves through search_path, so a
-- like-named table in an earlier schema would take the revoke instead and the
-- statutory tables would quietly keep their grants.
REVOKE UPDATE, DELETE ON public."member_register_entry" FROM openbrf_app;
REVOKE UPDATE, DELETE ON public."audit_log_entry" FROM openbrf_app;
REVOKE DELETE ON public."transfer" FROM openbrf_app;
REVOKE DELETE ON public."lien_note" FROM openbrf_app;

-- TRUNCATE is a separate privilege in Postgres and is not implied by DELETE,
-- so the grants above never conferred it. Revoked explicitly anyway, because
-- one TRUNCATE would empty the archive without firing a row-level trigger.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM openbrf_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM openbrf_app;

-- Migrations are the owner's job, so the application cannot reshape the schema
-- and cannot disable the triggers that back the rules above.
REVOKE CREATE ON SCHEMA public FROM openbrf_app;

-- PostgreSQL 15 and later revoke this by default, but a database restored from
-- an earlier dump keeps the old grant, and PUBLIC includes openbrf_app. The
-- role-specific revoke above does not touch it, so the application could still
-- create objects in the schema it is meant to be a guest in.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The job queue lives in its own schema. Because the application holds no
-- CREATE privilege, the schema is installed by the owner at deploy time with
-- `pnpm --filter @openbrf/api db:jobs`, which must run BEFORE this script so
-- the grants below have tables to apply to. The application then starts with
-- pg-boss migration disabled.
GRANT USAGE ON SCHEMA pgboss TO openbrf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO openbrf_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO openbrf_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO openbrf_app;

-- pg-boss creates partitions per queue while running, so future tables in that
-- schema must be reachable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openbrf_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO openbrf_app;

COMMIT;

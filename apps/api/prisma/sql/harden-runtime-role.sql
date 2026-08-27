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
--   psql "$DATABASE_URL" -v app_password="$RUNTIME_DB_PASSWORD" \
--     -f prisma/sql/harden-runtime-role.sql

\set ON_ERROR_STOP on

-- Built as a string and run with \gexec rather than inside a DO block. psql
-- does not substitute :'app_password' inside dollar quoting: the placeholder
-- reaches PostgreSQL literally and the block fails to parse before it creates
-- anything. Outside the quotes psql expands it, format(%L) quotes it as a
-- literal, and \gexec runs the statement that comes back.
SELECT format(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrf_app')
      THEN 'ALTER ROLE openbrf_app PASSWORD %L'
    ELSE 'CREATE ROLE openbrf_app LOGIN PASSWORD %L'
  END,
  :'app_password')
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
REVOKE UPDATE, DELETE ON "member_register_entry" FROM openbrf_app;
REVOKE UPDATE, DELETE ON "audit_log_entry" FROM openbrf_app;
REVOKE DELETE ON "transfer" FROM openbrf_app;
REVOKE DELETE ON "lien_note" FROM openbrf_app;

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

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrf_app') THEN
    EXECUTE format('CREATE ROLE openbrf_app LOGIN PASSWORD %L', :'app_password');
  ELSE
    EXECUTE format('ALTER ROLE openbrf_app PASSWORD %L', :'app_password');
  END IF;
END
$$;

GRANT CONNECT ON DATABASE openbrf TO openbrf_app;
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

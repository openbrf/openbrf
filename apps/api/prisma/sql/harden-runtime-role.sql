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
--   openbrf_owner  owns the schema and runs `prisma migrate deploy`; not a
--                  superuser (docker/db/initdb/10-schema-owner.sql)
--   openbrf_app    the application connection, owns nothing
--
-- Apply this script once, as the owner, after migrations. Then point the
-- application at openbrf_app via DATABASE_URL_RUNTIME. The owner needs
-- CREATEROLE to create openbrf_app, or ADMIN OPTION on it when it exists
-- already; on PostgreSQL 16 and later that reaches no role it was not given.
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
--
-- The names are quoted as identifiers, not as literals, so the message is
-- passed to RAISE as a parameter (%L) rather than as its format string: a
-- name holding ' or % would otherwise end the literal or read as a placeholder.
SELECT format($sql$DO $body$ BEGIN
  RAISE EXCEPTION '%%', %L;
END $body$$sql$, format('openbrf_app owns %s in this database. An owner can disable the statutory triggers, and a schema owner can drop the archive outright, regardless of the privileges this script sets. Reassign them to the schema owner first.',
  string_agg(owned.description, ', ' ORDER BY owned.description)))
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
-- because they belong to the granted role rather than to openbrf_app. The
-- owner cannot take one away either: on PostgreSQL 16 and later only the
-- grantor, or a superuser, may revoke a membership, and these were granted by
-- the superuser. So the script refuses and names the superuser's script, which
-- revokes them, rather than stopping on a bare permission error.
-- The message is passed as a parameter for the same reason as the ownership
-- refusal above.
SELECT format($sql$DO $body$ BEGIN
  RAISE EXCEPTION '%%', %L;
END $body$$sql$, format('openbrf_app is a member of %s, whose privileges this script cannot take away. Run docker/db/initdb/10-schema-owner.sql as the database superuser, which revokes these memberships (docs/deployment.md, "Upgrading to a separate schema owner"), then run this again.',
  string_agg(format('role %I', granted.rolname), ', ' ORDER BY granted.rolname)))
FROM pg_auth_members m
JOIN pg_roles member ON member.oid = m.member
JOIN pg_roles granted ON granted.oid = m.roleid
WHERE member.rolname = 'openbrf_app'
HAVING count(*) > 0
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
-- UPDATE as well as DELETE, unlike the two rows above it. A lien note is
-- released and a mis-keyed transfer corrected, so both keep UPDATE; a
-- tenant-ownership that has ceased has no later state to reach, so a
-- termination is as strictly append-only as the member register.
REVOKE UPDATE, DELETE ON public."termination" FROM openbrf_app;
-- A registered overlatelse having been havd or gone back to the seller, on the
-- same reading. The event has happened and there is no later state for the row
-- to reach; the transfer it undoes keeps its own record and its own UPDATE.
REVOKE UPDATE, DELETE ON public."transfer_reversal" FROM openbrf_app;
-- The obligation ledger, on the same reading as the termination above it. A row
-- states a statutory deadline: the event it reports cannot change, and neither
-- can the date Lag (2026:484) 3 kap. runs the two weeks from, so there is no
-- later state for an UPDATE to reach.
REVOKE UPDATE, DELETE ON public."register_report_obligation" FROM openbrf_app;

-- TRUNCATE is a separate privilege in Postgres and is not implied by DELETE,
-- so the grants above never conferred it. Revoked explicitly anyway, because
-- one TRUNCATE would empty the archive without firing a row-level trigger.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM openbrf_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM openbrf_app;

-- The migration history, which the blanket grant above reached as well. The
-- owner applies whatever the history says has not been applied, so a row
-- written here by the application would decide which migrations - a new
-- guard, a new revoke - never run, and one rewritten would stop every
-- deploy after it. Nothing in the application reads it.
REVOKE ALL ON public."_prisma_migrations" FROM openbrf_app;

-- Migrations are the owner's job, so the application cannot reshape the schema
-- and cannot disable the triggers that back the rules above.
REVOKE CREATE ON SCHEMA public FROM openbrf_app;

-- PostgreSQL 15 and later revoke this by default, but a database restored from
-- an earlier dump keeps the old grant, and PUBLIC includes openbrf_app. The
-- role-specific revoke above does not touch it, so the application could still
-- create objects in the schema it is meant to be a guest in.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The job queue lives in its own schema. The schema itself is installed by the
-- owner at deploy time with `pnpm --filter @openbrf/api db:jobs`, which must
-- run BEFORE this script so the grants below have tables to apply to. The
-- application then starts with pg-boss migration disabled.
GRANT USAGE ON SCHEMA pgboss TO openbrf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO openbrf_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO openbrf_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO openbrf_app;

-- The job schema's version, which the owner's pg-boss install reads to decide
-- which of its own migrations to run. The application reads it at start and
-- has no reason to write it.
--
-- The same row carries the timestamps pg-boss's maintenance stamps as it runs
-- (cron_on and its siblings), and those the application does write. So UPDATE
-- comes back column by column for every column but the version itself - read
-- from the catalog, because a pg-boss upgrade adds stamps of its own. The
-- table-level revoke also takes back any column grant an earlier run made, so
-- a column pg-boss drops loses its grant with it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pgboss.version FROM openbrf_app;
SELECT format('GRANT UPDATE (%s) ON pgboss.version TO openbrf_app',
  string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum))
FROM pg_attribute a
WHERE a.attrelid = 'pgboss.version'::regclass
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND a.attname <> 'version'
HAVING count(*) > 0
\gexec

-- Queues are declared at runtime, by the feature module that owns the queue
-- name, and that needs no CREATE: an ordinary queue is a row in pgboss.queue.
-- The one queue shape that creates a table of its own is a partitioned one,
-- and attaching that table to pgboss.job requires owning pgboss.job, which the
-- application never does - so CREATE here bought nothing a queue can use.
--
-- What it did buy was ownership. A table the application created would be the
-- application's, and the owner's pg-boss install works on the tables named in
-- pgboss.queue at every deploy; and the ownership refusal at the top of this
-- file would stop the next boot the moment one existed. An installation that
-- granted it before this revoke gets it taken away here.
REVOKE CREATE ON SCHEMA pgboss FROM openbrf_app;

-- Tables the owner adds to that schema later - a pg-boss upgrade migrating its
-- own schema - must be reachable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openbrf_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO openbrf_app;

COMMIT;

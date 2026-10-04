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
--                  superuser (docker/schema-owner.sql)
--   openbrf_app    the application connection, owns nothing
--
-- Apply this script once, as the owner, after migrations. Then point the
-- application at the runtime role via DATABASE_URL_RUNTIME. The owner needs
-- CREATEROLE to create the role, or ADMIN OPTION on it when it exists
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
--
-- RUNTIME_DB_ROLE names the runtime role, openbrf_app when it is unset or
-- empty. A role belongs to the whole PostgreSQL server rather than to one
-- database, so where several instances share a server each names its own: a
-- second instance applying this script to the same name would reset the
-- first's password and grant one role both databases. The container
-- entrypoint refuses a name that is not a plain lower-case identifier, that
-- starts with pg_, or that is the owner's own. Read from the environment like
-- the password, and quoted wherever it is used.
--
-- RUNTIME_DB_CONNECTION_LIMIT caps how many sessions the runtime role may hold
-- at once, 15 when it is unset or empty. The entrypoint sets it to the
-- application's pool plus the job queue's plus three to spare. On a shared
-- server that is what keeps one instance, or code running inside it, from
-- taking every connection the server has and stopping all the others. A value
-- below 1 is refused: -1 would mean no limit at all.

\set ON_ERROR_STOP on

\getenv app_password RUNTIME_DB_PASSWORD
-- psql leaves :'app_password' untouched when the variable was never defined,
-- which reaches PostgreSQL as a syntax error rather than as a clear message.
-- Defining it empty lets the check below speak for itself.
\if :{?app_password}
\else
\set app_password ''
\endif

-- The same for the role's name, which then falls back to openbrf_app: empty is
-- absent, as Compose passes an optional variable nobody set.
\getenv app_role RUNTIME_DB_ROLE
\if :{?app_role}
\else
\set app_role ''
\endif
SELECT coalesce(nullif(:'app_role', ''), 'openbrf_app') AS app_role
\gset

\getenv app_connection_limit RUNTIME_DB_CONNECTION_LIMIT
\if :{?app_connection_limit}
\else
\set app_connection_limit ''
\endif
SELECT coalesce(nullif(:'app_connection_limit', ''), '15') AS app_connection_limit
\gset

BEGIN;

-- Raised through \gexec because psql does not substitute inside dollar
-- quoting: the WHERE decides whether any statement is produced at all.
SELECT $sql$DO $body$ BEGIN
  RAISE EXCEPTION 'RUNTIME_DB_PASSWORD is not set. See the usage note at the top of this script.';
END $body$$sql$
WHERE coalesce(:'app_password', '') = ''
\gexec

-- The refusals below build their message with format() and raise it with
-- USING MESSAGE, which takes it as it is: a name holding a % sign or a quote
-- cannot turn into a placeholder or end the string.

-- What isolating one instance from its neighbours on a shared server rests on
-- (docs/deployment.md, "Several instances on one database server"). Two of
-- the three would otherwise fail open, with nothing reported.
--
-- Before PostgreSQL 16 a role with CREATEROLE may alter any role that is not a
-- superuser, including another instance's runtime role, and may grant itself
-- membership in another instance's owner. A superuser owner is the whole
-- server's anyway, so the version is checked only for an owner that is not.
SELECT format($sql$DO $body$ BEGIN RAISE EXCEPTION USING MESSAGE = %L; END $body$$sql$,
  format('The owner %I holds CREATEROLE on PostgreSQL %s. Before PostgreSQL 16 such a role can alter every other role on the server, the runtime roles of other instances included, so this script refuses to create one here. Upgrade the server to 16 or later.',
    current_user, current_setting('server_version')))
FROM pg_roles
WHERE rolname = current_user
  AND rolcreaterole
  AND NOT rolsuper
  AND current_setting('server_version_num')::int < 160000
\gexec

-- Only the database's owner, or a member of the role that owns it, may revoke
-- CONNECT from PUBLIC below. For anybody else PostgreSQL reports the REVOKE as
-- a warning rather than an error, ON_ERROR_STOP does not fire, and the
-- database would stay open to every role on the server.
SELECT format($sql$DO $body$ BEGIN RAISE EXCEPTION USING MESSAGE = %L; END $body$$sql$,
  format('Database %I is owned by %I, not by %I. Only its owner can close it to the other roles on the server, so the owner that runs this script has to own it: ALTER DATABASE %I OWNER TO %I.',
    d.datname, pg_get_userbyid(d.datdba), current_user, d.datname, current_user))
FROM pg_database d
WHERE d.datname = current_database()
  AND NOT pg_has_role(current_user, d.datdba, 'MEMBER')
\gexec

-- A runtime role that another database already grants CONNECT to is another
-- instance's: this script grants CONNECT on exactly one database. Taking it
-- over would reset that instance's password and give one role both databases.
-- PostgreSQL 16 refuses the ALTER ROLE below to an owner that did not create
-- the role, but not to one holding ADMIN OPTION on it - which
-- docker/schema-owner.sql gives the owner over a runtime role the superuser
-- created before the owner existed - nor to a superuser.
--
-- Only grants naming the role count. A database still open to PUBLIC says
-- nothing about whose role this is, and only that database's owner can close
-- it, so refusing here would stop this instance over a neighbour's database
-- (docs/deployment.md).
SELECT format($sql$DO $body$ BEGIN RAISE EXCEPTION USING MESSAGE = %L; END $body$$sql$,
  format('Role %I is granted CONNECT on %s as well, so it belongs to another instance on this server. Give this instance a runtime role of its own in RUNTIME_DB_ROLE.',
    :'app_role', string_agg(format('%I', d.datname), ', ' ORDER BY d.datname)))
FROM pg_database d
CROSS JOIN LATERAL aclexplode(d.datacl) AS acl
JOIN pg_roles r ON r.oid = acl.grantee
WHERE r.rolname = :'app_role'
  AND acl.privilege_type = 'CONNECT'
  AND d.datname <> current_database()
HAVING count(*) > 0
\gexec

-- Ownership outranks every privilege granted below, in three different ways.
-- The owner of a table can run ALTER TABLE ... DISABLE TRIGGER whatever its
-- ACL says, the owner of a schema can run DROP SCHEMA ... CASCADE and take
-- the statutory archive with it, and the owner of a function or a type can
-- drop it with CASCADE and take the triggers or the columns built on it. None
-- is reachable by any revoke in this file, so if the runtime role owns
-- anything the script refuses rather than reporting a hardening it did not
-- achieve. A table's row type, and the array type PostgreSQL makes beside
-- every type, are left out: they are reported through what they belong to.
--
-- The names are quoted as identifiers, not as literals, so the message is
-- passed to RAISE as a parameter (%L) rather than as its format string: a
-- name holding ' or % would otherwise end the literal or read as a placeholder.
SELECT format($sql$DO $body$ BEGIN
  RAISE EXCEPTION '%%', %L;
END $body$$sql$, format('Role %I owns %s in this database. An owner can disable the statutory triggers or drop what they are built on, and a schema owner can drop the archive outright, regardless of the privileges this script sets. Reassign them to the schema owner first.',
  :'app_role', string_agg(owned.description, ', ' ORDER BY owned.description)))
FROM (
  SELECT format('relation %I.%I', n.nspname, c.relname) AS description
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE r.rolname = :'app_role'
  UNION ALL
  SELECT format('schema %I', n.nspname)
  FROM pg_namespace n
  JOIN pg_roles r ON r.oid = n.nspowner
  WHERE r.rolname = :'app_role'
  UNION ALL
  SELECT format('function %s', p.oid::regprocedure)
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE r.rolname = :'app_role'
  UNION ALL
  SELECT format('type %I.%I', n.nspname, t.typname)
  FROM pg_type t
  JOIN pg_roles r ON r.oid = t.typowner
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE r.rolname = :'app_role'
    AND t.typrelid = 0
    AND NOT EXISTS (SELECT 1 FROM pg_type e WHERE e.typarray = t.oid)
) AS owned
HAVING count(*) > 0
\gexec

-- A runtime role that already exists may have been made by hand or by an
-- earlier tool. SUPERUSER or BYPASSRLS on it would ignore every revoke in this
-- file, so the script refuses rather than reporting a hardening it did not
-- achieve. Refusing is deliberate here instead of quietly stripping the
-- attributes: only a superuser may clear SUPERUSER, so a script that tried
-- would fail for the very installers that most need to know, and a runtime
-- role that arrived with those attributes is an anomaly a human should look
-- at rather than something to paper over.
SELECT format($sql$DO $body$ BEGIN
  RAISE EXCEPTION 'Role %I already exists with %s. This script cannot constrain such a role: those attributes override the privileges it sets. Fix the role, or drop it and run this again.';
END $body$$sql$,
  :'app_role',
  concat_ws(', ',
    CASE WHEN rolsuper THEN 'SUPERUSER' END,
    CASE WHEN rolbypassrls THEN 'BYPASSRLS' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN rolreplication THEN 'REPLICATION' END))
FROM pg_roles
WHERE rolname = :'app_role'
  AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
\gexec

-- LOGIN is set on both branches, not only on create: PrismaService and
-- JobQueueService both connect as this role through DATABASE_URL_RUNTIME, so
-- an existing NOLOGIN role would leave the application unable to start.
-- Built as a string and run with \gexec for the same reason as above: psql
-- does not substitute :'app_password' inside a dollar-quoted DO body, so the
-- placeholder would reach PostgreSQL literally.
--
-- On a server shared by several instances the owner is not a superuser but
-- holds CREATEROLE. From PostgreSQL 16 such a role may alter only the roles it
-- created, so one instance's owner reaching for another's runtime role fails
-- here rather than taking it over.
--
-- The connection limit is cast here, so a value that is not a whole number
-- stops the script instead of reaching the statement as text. A whole number
-- below 1 stops it too: -1 is how PostgreSQL spells "no limit", and a role
-- without one is what the limit exists to prevent on a shared server.
SELECT $sql$DO $body$ BEGIN
  RAISE EXCEPTION 'RUNTIME_DB_CONNECTION_LIMIT has to be a whole number of 1 or more. -1 would remove the runtime role''s connection limit.';
END $body$$sql$
WHERE (:'app_connection_limit')::integer < 1
\gexec

SELECT format(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
      THEN 'ALTER ROLE %I WITH LOGIN CONNECTION LIMIT %s PASSWORD %L'
    ELSE 'CREATE ROLE %I WITH LOGIN CONNECTION LIMIT %s PASSWORD %L'
  END,
  :'app_role',
  (:'app_connection_limit')::integer,
  :'app_password')
\gexec

-- A role membership carries privileges that the revokes below cannot reach,
-- because they belong to the granted role rather than to the runtime role.
-- The owner cannot take one away either: on PostgreSQL 16 and later only the
-- grantor, or a superuser, may revoke a membership, and the owner grants none.
-- So the script refuses and names the superuser's script, which revokes them,
-- rather than stopping on a bare permission error.
-- The message is passed as a parameter for the same reason as the ownership
-- refusal above.
SELECT format($sql$DO $body$ BEGIN
  RAISE EXCEPTION '%%', %L;
END $body$$sql$, format('Role %I is a member of %s, whose privileges this script cannot take away. The schema-owner service revokes these memberships as the database superuser on every `up` (docker/schema-owner.sql); on a server you do not administer, ask its administrator to revoke them. Then run this again.',
  :'app_role', string_agg(format('role %I', granted.rolname), ', ' ORDER BY granted.rolname)))
FROM pg_auth_members m
JOIN pg_roles member ON member.oid = m.member
JOIN pg_roles granted ON granted.oid = m.roleid
WHERE member.rolname = :'app_role'
HAVING count(*) > 0
\gexec

-- The database name comes from the connection string in the usage note above,
-- so it is read from the connection rather than assumed to be "openbrf".
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role')
\gexec

-- A new database grants CONNECT to PUBLIC, which is every role on the server.
-- On a server shared by several instances that would let each runtime role
-- connect to every other instance's database and read its catalogue. The
-- runtime role holds its own grant above and the owner owns the database, so
-- nothing this instance runs loses anything; a third role an operator connects
-- with - monitoring, a backup user - is granted CONNECT explicitly
-- (docs/deployment.md).
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database())
\gexec

-- And checked afterwards rather than trusted. A grant to PUBLIC made by a
-- role other than the owner survives the owner's REVOKE, again with no more
-- than a warning, and an ACL that was never written still means the default:
-- CONNECT for everyone.
SELECT format($sql$DO $body$ BEGIN RAISE EXCEPTION USING MESSAGE = %L; END $body$$sql$,
  format('Database %I is still open to every role on the server, or not open to %I by a grant of its own. Revoke CONNECT from PUBLIC as the role that granted it, then start again.',
    d.datname, :'app_role'))
FROM pg_database d
WHERE d.datname = current_database()
  AND (
    d.datacl IS NULL
    OR EXISTS (
      SELECT 1 FROM aclexplode(d.datacl) AS acl
      WHERE acl.grantee = 0 AND acl.privilege_type = 'CONNECT'
    )
    OR NOT EXISTS (
      SELECT 1 FROM aclexplode(d.datacl) AS acl
      JOIN pg_roles r ON r.oid = acl.grantee
      WHERE r.rolname = :'app_role' AND acl.privilege_type = 'CONNECT'
    )
  )
\gexec
GRANT USAGE ON SCHEMA public TO :"app_role";

-- Ordinary service-tier access.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

-- The statutory archive: insert and read only. Revoked after the blanket
-- grant above so the order of this script matters.
-- Schema-qualified: an unqualified name resolves through search_path, so a
-- like-named table in an earlier schema would take the revoke instead and the
-- statutory tables would quietly keep their grants.
REVOKE UPDATE, DELETE ON public."member_register_entry" FROM :"app_role";
REVOKE UPDATE, DELETE ON public."audit_log_entry" FROM :"app_role";
REVOKE DELETE ON public."transfer" FROM :"app_role";
REVOKE DELETE ON public."lien_note" FROM :"app_role";
-- UPDATE as well as DELETE, unlike the two rows above it. A lien note is
-- released and a mis-keyed transfer corrected, so both keep UPDATE; a
-- tenant-ownership that has ceased has no later state to reach, so a
-- termination is as strictly append-only as the member register.
REVOKE UPDATE, DELETE ON public."termination" FROM :"app_role";
-- A registered overlatelse having been havd or gone back to the seller, on the
-- same reading. The event has happened and there is no later state for the row
-- to reach; the transfer it undoes keeps its own record and its own UPDATE.
REVOKE UPDATE, DELETE ON public."transfer_reversal" FROM :"app_role";
-- The obligation ledger, on the same reading as the termination above it. A row
-- states a statutory deadline: the event it reports cannot change, and neither
-- can the date Lag (2026:484) 3 kap. runs the two weeks from, so there is no
-- later state for an UPDATE to reach.
REVOKE UPDATE, DELETE ON public."register_report_obligation" FROM :"app_role";

-- TRUNCATE is a separate privilege in Postgres and is not implied by DELETE,
-- so the grants above never conferred it. Revoked explicitly anyway, because
-- one TRUNCATE would empty the archive without firing a row-level trigger.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM :"app_role";

-- The migration history, which the blanket grant above reached as well. The
-- owner applies whatever the history says has not been applied, so a row
-- written here by the application would decide which migrations - a new
-- guard, a new revoke - never run, and one rewritten would stop every
-- deploy after it. Nothing in the application reads it.
REVOKE ALL ON public."_prisma_migrations" FROM :"app_role";

-- Migrations are the owner's job, so the application cannot reshape the schema
-- and cannot disable the triggers that back the rules above.
REVOKE CREATE ON SCHEMA public FROM :"app_role";

-- PostgreSQL 15 and later revoke this by default, but a database restored from
-- an earlier dump keeps the old grant, and PUBLIC includes the runtime role.
-- The role-specific revoke above does not touch it, so the application could
-- still create objects in the schema it is meant to be a guest in.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The job queue lives in its own schema. The schema itself is installed by the
-- owner at deploy time with `pnpm --filter @openbrf/api db:jobs`, which must
-- run BEFORE this script so the grants below have tables to apply to. The
-- application then starts with pg-boss migration disabled.
GRANT USAGE ON SCHEMA pgboss TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO :"app_role";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO :"app_role";

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
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pgboss.version FROM :"app_role";
SELECT format('GRANT UPDATE (%s) ON pgboss.version TO %I',
  string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum), :'app_role')
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
REVOKE CREATE ON SCHEMA pgboss FROM :"app_role";

-- Tables the owner adds to that schema later - a pg-boss upgrade migrating its
-- own schema - must be reachable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

COMMIT;

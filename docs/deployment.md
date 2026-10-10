# Running an Open BRF instance

One housing cooperative, one instance: an application container and a
PostgreSQL container, two containers that prepare the database on every deploy
and exit, and nothing else to install.

> **Not yet ready to hold a housing cooperative's data.** See
> [ROADMAP.md](../ROADMAP.md) for what is actually built. This document
> describes how the instance runs, not that it is ready to run.

## What you need

- Docker with Compose v2
- A machine reachable at the public https:// address members will use, with TLS
  in front of it. Passkeys need a secure origin, and so does a session cookie
  that is worth anything.

## Starting an instance

An instance needs two files: `docker-compose.prod.yml` and
`.env.production.example`. Every release carries both as assets, the second
under the name `env.production.example`, so either download them from the
release to run

```sh
mkdir openbrf && cd openbrf
curl -fLO https://github.com/openbrf/openbrf/releases/download/v0.1.0/docker-compose.prod.yml
curl -fL -o .env.production https://github.com/openbrf/openbrf/releases/download/v0.1.0/env.production.example
```

or take them from a clone of the repository:

```sh
git clone https://github.com/openbrf/openbrf.git
cd openbrf
cp .env.production.example .env.production
```

Set `OPENBRF_VERSION` in `.env.production` to the release line to run, such as
`0.1` (see [Versions and upgrades](#versions-and-upgrades)), and fill in the
five secrets it asks for, generating each with

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Any character is allowed in the database passwords. They end up inside
PostgreSQL connection URLs, where `:`, `/`, `@`, `?` and `#` are delimiters, and
the entrypoint percent-encodes them as it builds those URLs.

Set `APP_URL` to the public https:// address members will use. Invitation and
sign-in links are built from it, and the session cookie is issued for it, so a
wrong value here produces links that go nowhere. It is the origin and nothing
more: the association's own website is served at that address, and the
application at `/app` below it.

The instance refuses to start if it is neither an `https://` address nor a
loopback one. That is not style: it is also the origin external programs sign in
against, and an address that is not reachable over TLS cannot be one.

**Changing `APP_URL` later disconnects every connected app.** An access token is
issued for one address, and a token issued for the old one is refused after the
change - by design, since a token must not be accepted by a server it was not
issued for. Members reconnect their apps afterwards; nothing else is affected,
and nothing is lost. Worth knowing before moving an instance to a new domain.

Then:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

An unclaimed instance prints its setup link to its log once it is up:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production logs app
```

```
This instance is unclaimed. Open https://brf.example.se/app/setup#claim=... to
create the first administrator. The link works until the instance is claimed or
restarted.
```

Open that link. The setup wizard creates the first administrator account, the
housing cooperative, its addresses and its apartments, the email settings and
the accent colour. Everything after the administrator account and the name can
be skipped and finished later in settings.

The wizard is public only while the instance is unclaimed - no account exists
and setup has never been completed - and admin-only from its second screen
onwards. Its first step creates the administrator only for whoever holds the
setup link, so somebody who merely finds a fresh instance cannot claim it
([ADR 0023](adr/0023-claiming-a-fresh-instance.md)). Reached without the link,
the wizard asks for the setup code, which is the part of the link after
`#claim=`.

The link lives in the process's memory, not in the database. It stops working
once the instance is claimed, and a restart before that prints a new link and
ends the old one, so a link that may have been seen by somebody else is ended
by restarting. The link is in the container's log for as long as that log is
kept, and wherever the log is shipped; it opens nothing once the instance is
claimed.

A host that hands the link to the board instead mints the token itself and sets
its digest as `OPENBRF_SETUP_TOKEN_DIGEST` before the first start
(`.env.production.example` shows how). The instance then prints no link, only
that it waits for its setup link, and the link is
`<APP_URL>/app/setup#claim=<token>`.

Once the instance is claimed, `APP_URL` serves the association's own public
website and the application moves to `/app` under it. Finishing the wizard
writes two pages so the address answers with something: a front page, and a
privacy notice whose headings the board fills in and which is linked from the
footer of every page. Both are edited from `/app/admin/site`, which the board
reaches by default. The wizard also writes the menu entry for the first page,
because the menu decides which page the address serves: the root answers with
the menu's first page entry, and the menu is arranged from
`/app/admin/site/menu`. The public pages are plain HTML rendered by the API through
the active theme: they run no JavaScript, set no cookie and fetch nothing from
any other host, which is also why the site needs no cookie banner.

An instance claimed before the privacy notice existed is written one on its
next start. It is the only page written outside the wizard, and writing it is
idempotent: an instance that already has one is left alone, and so is a notice
the board has since rewritten.

## What happens on every deploy

Every `up` runs two services before the application. Both are the same image as
the application, started with a command of their own, and both do their job and
exit; the next starts only if the one before it succeeded.

`schema-owner` makes sure the schema owner exists, as the database's superuser
([schema-owner.sql](../docker/schema-owner.sql)). The owner is `openbrf_owner`
unless `OWNER_DB_USER` names another: a role that owns the database, its
schemas and every table in them, and is not a superuser. On an instance whose
tables the superuser still owns, it moves them to the owner. After that it
changes nothing but the owner's password, which it sets from
`OWNER_DB_PASSWORD` each time.

`migrate` then does, in this order:

1. The data volume's directories are created and checked for writability.
2. The schema owner's connection is checked: it has to work, and it must not be
   a superuser.
3. The field encryption key is provisioned if, and only if, this is a genuine
   first boot. See [ADR 0004](adr/0004-encryption-key-provisioning.md) and
   [backup-and-restore.md](backup-and-restore.md).
4. Database migrations are applied, as the schema owner. A trigger fires for
   whoever writes its table, and the migrations write as the owner, so the
   triggers on the tables in `public` and `pgboss` are checked first
   ([check-triggers.mjs](../apps/api/scripts/check-triggers.mjs)). The step
   stops on a trigger that is not, word for word, one the migrations or the job
   schema install create, or that calls a function the table's owner does not
   own. It also stops while a role other than a table's owner, or every role
   through `PUBLIC`, holds `TRIGGER` on such a table, or is given it by the
   owner's default privileges: that privilege is enough to replace a trigger
   without owning the table, the guards on the statutory archive and on
   `pgboss.queue` among them. The triggers are checked as well as the grants
   because the hardening in step 6, or the `REVOKE` below for a role you
   manage yourself, takes the grant away and leaves a trigger it was used to
   replace where it is.
5. The job queue schema is installed or migrated, as the owner. It stops on a
   queue that is partitioned or names a job table of its own, which Open BRF
   never declares, because pg-boss builds SQL from those names as the owner.
   An upgrade that adds an index to the job tables builds it here too, and the
   step waits until every build has finished: the application never runs
   pg-boss migrations, so nothing would finish one later. A build that fails
   stops the deploy with its error, which also stays in `pgboss.bam`, and the
   next deploy retries it. A trigger on `pgboss.queue`, owned by the schema
   owner, makes the table refuse such a queue from then on, so the application
   cannot write one between the check and the migration. The step checks the
   triggers and the `TRIGGER` grants again as step 4 does, before it puts that
   trigger back, and once more after pg-boss has created its tables.
6. The application's own database role is created and constrained: `openbrf_app`,
   or the name `RUNTIME_DB_ROLE` gives it.

The owner's URL is built separately for each of steps 2 to 6, inside the
process that uses it, so it is never a shell variable and never written to a
stream; a `DATABASE_URL` that is set on the `migrate` service is used as given.
The application builds its own URL from `POSTGRES_HOST`, `POSTGRES_PORT` and
`POSTGRES_DB` unless `DATABASE_URL_RUNTIME` is set, so step 6 checks that the
owner's URL and the application's name the same server and database:

- With no `DATABASE_URL_RUNTIME`, a `DATABASE_URL` that names another server or
  database than `POSTGRES_HOST`, `POSTGRES_PORT` and `POSTGRES_DB` is refused.
- With `DATABASE_URL_RUNTIME` and `RUNTIME_DB_PASSWORD` both set, the two URLs
  are compared with each other and `POSTGRES_HOST`, `POSTGRES_PORT` and
  `POSTGRES_DB` are not consulted. A mismatch is refused.
- With `DATABASE_URL_RUNTIME` and no `RUNTIME_DB_PASSWORD`, you manage the role
  yourself, nothing is hardened, and no comparison is made.

The application's container assembles its own connection URL from the runtime
role's password and starts. It is never given the owner's credentials or the
superuser's, and it refuses to start if it is: a `POSTGRES_PASSWORD`, an
`OWNER_DB_PASSWORD`, or a `DATABASE_URL` beside the runtime connection stops it
with a message that says which. The application asks the same again before it
connects, for a platform that starts it without the image's entrypoint. Once
started, it asks the database whether the
role it connected as is a constrained one, and refuses to serve if the answer
is no - a superuser, a role that owns the database or its tables or can create
objects in its schemas, or one that holds any privilege the hardening takes
away on the statutory archive, the migration history or the job schema's
version. Its first line after listening names the release and the commit it was
built from, as `Open BRF 0.1.0 (1a2b3c4d5e6f)`.

Both deploy services and the application are refused before anything connects
when `RUNTIME_DB_ROLE` cannot be a runtime role's name: see
[Several instances on one database server](#several-instances-on-one-database-server).

Every step is idempotent, so upgrading is a newer image and the same `up -d`
that started the instance:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

`pull` fetches the image `OPENBRF_VERSION` names as it stands at that moment:
the newest patch release of a line such as `0.1`, or the one exact version.
Stop the application and take a backup before it; see
[the upgrade, step by step](#the-upgrade-step-by-step).

Both selectors belong on every one of those commands. Without
`-f docker-compose.prod.yml`, Compose picks up the `docker-compose.yml` in this
repository instead, which defines the development database and no application
at all: the upgrade would touch the wrong volumes and leave the running
instance on its old image.

A build from a checkout, rather than a release, is an image under a tag of
its own that `OPENBRF_VERSION` then names. It is never pulled, so `pull` is
not part of running it:

```sh
docker build -t ghcr.io/openbrf/openbrf:checkout .
# OPENBRF_VERSION=checkout in .env.production
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

**What a failed migration leaves.** The `migrate` service stops at the first
error and exits with a non-zero status, `up` reports it, and the application is
not started. The failing migration is rolled back
whole, because each migration runs in one transaction, but the migrations
applied before it in the same start stay applied, and the failure is recorded
in the database's `_prisma_migrations` table, which makes every later start
refuse to migrate until it is resolved. The database is then between two
releases, and the previous image is not guaranteed to run against it.

**Rolling back** is restoring the backup taken before the upgrade - the
database and the data volume together, as
[backup-and-restore.md](backup-and-restore.md) takes them - and starting the
previous image, named by its exact version. Never the database alone: a start
can rewrite the stored files on the volume before the application listens
([ADR 0015](adr/0015-stored-files-encrypted-at-rest.md)). Never the previous image
against the newer database. And never `prisma migrate resolve` to push past a
failed migration: it records the migration as dealt with without doing what it
does.

**One container per database.** An upgrade that starts the new container before
stopping the old one runs the migrations under a live older release. Stop, back
up, start.

## Versions and upgrades

Every release is published as `ghcr.io/openbrf/openbrf`, one image for
`linux/amd64` and `linux/arm64`, under up to three tags:

- `X.Y.Z`, the release itself, which never moves;
- `X.Y`, the release line, which moves to each patch release of that line;
- `X`, from 1.0.0 on, which moves to each release of that major version.

There is no `latest` tag. A tag that moved across release lines would install
the one upgrade an operator is meant to choose. A patch to an older line moves
that line's tag and nothing else.

`OPENBRF_VERSION` is one of those tags. A line follows its patch releases on
every `pull`; an exact version stays where it is; and a version with its
digest, `0.1.0@sha256:<digest>`, is that image and no other, whatever happens to
any tag. The digest is the one the release's attestation names and
`docker buildx imagetools inspect ghcr.io/openbrf/openbrf:0.1.0` prints.

What a release may change follows from its version:

- **A patch release** (0.1.0 to 0.1.1) fixes without changing anything an
  operator does, and can be installed without anybody choosing it.
- **Before 1.0, a minor release** (0.1 to 0.2) may carry something an operator
  has to act on - a new required variable, a variable removed or renamed, a
  PostgreSQL major version no longer supported, a plugin API version no longer
  accepted, a data change that needs a manual step - and waits for the
  operator's choice. Its release notes say what.
- **From 1.0 on**, minor releases join patch releases, and anything on that
  list is a major release instead. [CONTRIBUTING.md](../CONTRIBUTING.md),
  "Releasing the platform", is the rule a release is versioned by.

Every image carries a build provenance attestation that names the commit and
the workflow that built it. The release carries the same attestation as its
asset `openbrf-X.Y.Z.intoto.jsonl`, and this checks the image against it:

```sh
gh attestation verify oci://ghcr.io/openbrf/openbrf:0.1.0 \
  --repo openbrf/openbrf \
  --signer-workflow openbrf/openbrf/.github/workflows/image.yml
```

The image's labels say the same: `org.opencontainers.image.version` and
`org.opencontainers.image.revision`.

### The upgrade, step by step

The order an operator follows by hand, and the one an automated upgrade has to
follow as well:

1. Stop the application, then back up the database and the data volume
   ([backup-and-restore.md](backup-and-restore.md), "Before an upgrade").
2. Start the target image by digest - the digest its attestation names, not a
   tag that could move.
3. The upgrade has succeeded when the container's health is `healthy` within
   its start period.
4. Otherwise, stop it, restore both halves of the backup, and start the
   previous image by its digest.

## Three database roles, and why

The member register and the audit log are append-only, enforced by triggers in
the database rather than by application code alone. A table's owner can run
`ALTER TABLE ... DISABLE TRIGGER` and walk straight past them, so the
application must not be the owner. And migrations need to own the tables and
nothing more, so the role that runs them must not be a superuser.

| Role            | What it is                                                                                                                                                                                                                                                                                                                                                                                                                 | Password              | Given to                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------- |
| `openbrf`       | The superuser the database image creates.                                                                                                                                                                                                                                                                                                                                                                                  | `POSTGRES_PASSWORD`   | `db` and `schema-owner`   |
| `openbrf_owner` | Owns the database, its schemas and its tables, and runs migrations. Not a superuser; its one attribute is `CREATEROLE`, which on PostgreSQL 16 and later reaches only the runtime role. Created, and its password set, by the `schema-owner` service on every `up`. `OWNER_DB_USER` names it otherwise.                                                                                                                    | `OWNER_DB_PASSWORD`   | `schema-owner`, `migrate` |
| `openbrf_app`   | The application's connection. Owns nothing, creates nothing, and has `UPDATE` and `DELETE` revoked on the statutory tables and every write revoked on the migration history, on the job schema's version and on its queue of index builds. Created and constrained by the `migrate` service on every deploy, so the privileges are reapplied after any migration that added a table. `RUNTIME_DB_ROLE` names it otherwise. | `RUNTIME_DB_PASSWORD` | `migrate` and `app`       |

Neither the owner's credentials nor the superuser's reach the application's
container. No password is passed as a process argument - `/proc/<pid>/cmdline`
is readable by every process in a container, and the environment is not - and
each is given only to the service that needs it, which exits once it has run.
The instance's three containers run with a read-only root filesystem, no
capabilities and `no-new-privileges`, and the code in them is owned by root:
the user they run as can write to `/data` and `/tmp` and nowhere else.

An operator who manages the runtime role themselves can leave
`RUNTIME_DB_PASSWORD` empty in `.env.production` and set `DATABASE_URL_RUNTIME`
there instead; the `migrate` service then skips step 6 and constrains nothing,
so the role has to be granted no more than
[harden-runtime-role.sql](../apps/api/prisma/sql/harden-runtime-role.sql) grants
it. A `DATABASE_URL_RUNTIME` supplied that way is used as written, so its
password has to be percent-encoded already. The entrypoint still refuses one
that signs in as the owner, carries a `user` query parameter, which would
override the user in the URL, or names no user, which the server's `PGUSER`
would fill in. The same two are refused in `DATABASE_URL`, so that the owner's
name read from it is the one that signs in, and so is a `password` or
`sslpassword` query parameter there, which would reach psql's arguments. The
application's own check at start is what catches a role granted more than the
hardening leaves it; an instance that upgrades from a release before this
check has to take that away first
([Upgrading to a separate schema owner](#upgrading-to-a-separate-schema-owner)).

Neither variable is required by the Compose file, because requiring either one
would make the other impossible to use. The entrypoint is what refuses a
production start that has neither, because the alternative is an application
connecting as the owner - so that refusal, rather than a missing value in the
env file, is the error an operator who has set up neither will read.

## Upgrading to a separate schema owner

An instance installed before the schema owner existed ran its migrations as the
superuser, which owns every table. The release that brings the owner also
changes `docker-compose.prod.yml`: it adds the `schema-owner` and `migrate`
services, and no longer gives the application the superuser's password. The new
image refuses to start under the old file, so the upgrade replaces it first.
These steps are for an instance on the database `docker-compose.prod.yml`
bundles; one on a server it shares with others follows
[An instance on a shared database server](#an-instance-on-a-shared-database-server)
instead.

1. Back up ([backup-and-restore.md](backup-and-restore.md), "Before an
   upgrade").
2. Download the release's `docker-compose.prod.yml` over yours, and its
   `env.production.example` beside it, naming the release you upgrade to as in
   [Starting an instance](#starting-an-instance). Carry over anything you
   changed in the old compose file. From a clone of the repository, check out
   the release's tag instead, which brings both.

   ```sh
   curl -fLO https://github.com/openbrf/openbrf/releases/download/vX.Y.Z/docker-compose.prod.yml
   curl -fLO https://github.com/openbrf/openbrf/releases/download/vX.Y.Z/env.production.example
   ```

3. Add the owner's password to `.env.production`, generated like the others,
   and set `OPENBRF_VERSION` to the release line you upgrade to.
   `env.production.example` shows every variable the release reads.

   ```sh
   OWNER_DB_PASSWORD="..."
   ```

4. `pull`, then `up -d`.
5. Change the superuser's password. Until this release the application's
   container held it, and the superuser still signs in with a password over the
   compose network, because the `schema-owner` service connects that way on
   every `up`. Set a new one, generated like the others; psql asks for it and
   sends only its hash, so it reaches neither a process argument nor a log:

   ```sh
   docker compose -f docker-compose.prod.yml --env-file .env.production \
     exec db psql -U openbrf -d openbrf -c '\password openbrf'
   ```

   Then put the same password in `POSTGRES_PASSWORD` in `.env.production`,
   before the next `up`, which would otherwise stop at the `schema-owner`
   service.

The `schema-owner` service creates the owner and moves to it everything the
superuser owns in the application's schemas, so the `migrate` service after it
runs as the owner. Anything another role owns there - an object the runtime
role created in the job schema, where an earlier release let it - is not moved:
the service stops and names it, so that you can look at it, hand it to the
owner or drop it, and run `up -d` again.

The `schema-owner` service also revokes any role the runtime role has been made
a member of. Such a membership lends it privileges that no revoke on the
runtime role reaches, and only the superuser can take back a membership the
superuser granted, so the `migrate` service refuses to harden the role while one
is left and names the `schema-owner` service.

If you manage the runtime role yourself (`DATABASE_URL_RUNTIME` set,
`RUNTIME_DB_PASSWORD` empty), the `migrate` service does not touch it, and a
role that was granted every write in `public` by an earlier release can still
write the migration history, or create objects in the job schema. The
application refuses to start as such a role, as one that holds `TRIGGER` on a
table in `public` or `pgboss`, and as one that owns anything in the
application's schemas or is a member of another role, so constrain it before
the upgrade's `up -d`.

If you have a checkout, apply
[harden-runtime-role.sql](../apps/api/prisma/sql/harden-runtime-role.sql) to it
again as the owner, once the `schema-owner` service has run. The script also
sets the role's password, from `RUNTIME_DB_PASSWORD`, so give it the password
your `DATABASE_URL_RUNTIME` already uses, and the role's name in
`RUNTIME_DB_ROLE` unless it is `openbrf_app`. The variables are set in your
shell only and handed to the container by name, which keeps them out of the
process arguments; `.env.production` keeps `RUNTIME_DB_PASSWORD` empty.

```sh
compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
}

compose up schema-owner
read -rs RUNTIME_DB_PASSWORD && export RUNTIME_DB_PASSWORD
compose exec -T -e RUNTIME_DB_PASSWORD -e RUNTIME_DB_ROLE db \
  psql -U openbrf_owner -d openbrf -f - < apps/api/prisma/sql/harden-runtime-role.sql
unset RUNTIME_DB_PASSWORD
```

Otherwise revoke the privileges the release took away, as the superuser,
naming your role and the role that owns the schemas (`my_schema_owner` below).
The `ALTER DEFAULT PRIVILEGES` statements need that owner named with `FOR ROLE`,
because a default privilege belongs to the role that creates the tables. pg-boss's maintenance stamps the times it ran on the
`pgboss.version` row, so the last statement grants `UPDATE` back on every
column of that table except `version`, read from the catalog as the hardening
script does. Without it, the application's maintenance fails.

```sh
compose exec -T db psql -U openbrf -d openbrf -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
REVOKE ALL ON public._prisma_migrations FROM my_runtime_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pgboss.version FROM my_runtime_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pgboss.bam FROM my_runtime_role;
REVOKE CREATE ON SCHEMA pgboss FROM my_runtime_role;
REVOKE TRIGGER, REFERENCES, TRUNCATE ON ALL TABLES IN SCHEMA public, pgboss
  FROM my_runtime_role, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE my_schema_owner IN SCHEMA public, pgboss
  REVOKE TRIGGER, REFERENCES, TRUNCATE ON TABLES FROM my_runtime_role, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE my_schema_owner
  REVOKE TRIGGER, REFERENCES, TRUNCATE ON TABLES FROM my_runtime_role, PUBLIC;
SELECT format('GRANT UPDATE (%s) ON pgboss.version TO my_runtime_role',
  string_agg(quote_ident(attname), ', ' ORDER BY attnum))
FROM pg_attribute
WHERE attrelid = 'pgboss.version'::regclass
  AND attnum > 0 AND NOT attisdropped AND attname <> 'version'
\gexec
COMMIT;
SQL
```

Run the `GRANT` again after an upgrade that adds a column to `pgboss.version`.

### An instance on a shared database server

An instance on a server it shares with others named its own owner in
`POSTGRES_USER` and `POSTGRES_PASSWORD`, and started the application alone. That
owner already owns the database and its tables, so nothing has to move to a new
one, and the `schema-owner` service, which runs as the server's superuser, is
not run: it refuses a `POSTGRES_USER` that is not one. The migrations now run in
a service of their own, before the application starts.

An owner that was the server's superuser has to give way to one that is not,
because the `migrate` service refuses to run as a superuser. Such an instance
follows the steps below with two changes. In step 3, leave `POSTGRES_USER` and
`POSTGRES_PASSWORD` naming the superuser for one run, and name a new owner in
`OWNER_DB_USER` and `OWNER_DB_PASSWORD`. In place of step 4, run
`compose run --rm --no-deps schema-owner` (`compose` as in step 5): it creates
the owner, hands it what the superuser owns and revokes the runtime role's
memberships. Then remove `POSTGRES_PASSWORD` from the env file and go on with
step 5.

1. Back up ([backup-and-restore.md](backup-and-restore.md), "Before an
   upgrade").
2. Download the release's `docker-compose.prod.yml` and
   `env.production.example`, as in step 2 above.
3. In `.env.production`, rename `POSTGRES_USER` to `OWNER_DB_USER` and
   `POSTGRES_PASSWORD` to `OWNER_DB_PASSWORD`, keeping their values: the owner
   and its password stay as they are. Set `OPENBRF_VERSION` to the release line
   you upgrade to.

   ```sh
   OWNER_DB_USER="brf_example_owner"
   OWNER_DB_PASSWORD="..."
   ```

4. Have the server's administrator revoke any role the runtime role is a member
   of: the `migrate` service refuses to harden the role while one is left, and
   names each. Then the instance's owner, connected as itself, hands itself
   anything the runtime role owns in the instance's database - an object in the
   job schema, where an earlier release let it create - which the `migrate`
   service refuses as well. The owner runs this rather than the administrator:
   run by the superuser, the last `REVOKE` also takes the owner's ADMIN option
   on the runtime role, and the `migrate` service then fails because it cannot
   alter that role. Here `brf_example_app` is the runtime role, the name in
   `RUNTIME_DB_ROLE`, and `db.example.se` is the server in `POSTGRES_HOST`:

   ```sh
   psql -h db.example.se -U brf_example_owner -d brf_example -v ON_ERROR_STOP=1 <<'SQL'
   GRANT brf_example_app TO brf_example_owner;  -- PostgreSQL 16 asks for it first
   REASSIGN OWNED BY brf_example_app TO brf_example_owner;
   REVOKE brf_example_app FROM brf_example_owner;
   SQL
   ```

5. Run the deploy steps, then the application:

   ```sh
   compose() {
     docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
   }

   compose pull migrate app
   compose run --rm --no-deps migrate
   compose up -d --no-deps app
   ```

Until this release the application's container held the owner's password as
well, in `POSTGRES_PASSWORD`. Once the instance runs, change it as the owner,
and then in `OWNER_DB_PASSWORD`:

```sh
psql -h db.example.se -U brf_example_owner -d brf_example -c '\password brf_example_owner'
```

An override file that added `DATABASE_URL` to the `app` service adds it to the
`migrate` service instead: the application refuses to start with the owner's
connection in its environment. `POSTGRES_HOST`, `POSTGRES_PORT` and
`POSTGRES_DB` in the env file name the same server and database, because the
application builds its connection from them.

## Several instances on one database server

One PostgreSQL server can hold the databases of several instances. Each is
still a container of its own, with its own data volume and its own key. It
reaches the server through `POSTGRES_HOST`, `POSTGRES_PORT` and `POSTGRES_DB`,
names its schema owner in `OWNER_DB_USER`, and gives the owner's and the
runtime role's passwords, all set in `.env.production`; left empty, the first
three name the database `docker-compose.prod.yml` bundles.

The server's administrator creates each instance's owner and its database,
owned by it, before the instance first starts:

```sql
CREATE ROLE brf_example_owner LOGIN CREATEROLE PASSWORD '...';
CREATE DATABASE brf_example OWNER brf_example_owner;
```

An administrator holding the server's superuser can have the `schema-owner`
service do it instead, with `POSTGRES_USER` and `POSTGRES_PASSWORD` naming that
superuser in the env file for the one run, and the database created first:
`run --rm --no-deps schema-owner`. Either way the instance's containers never
hold the superuser's password afterwards.

Such an instance has no use for the bundled database, so it runs the deploy
steps and then the application alone, and upgrades the same way:

```sh
compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
}

compose pull migrate app
compose run --rm --no-deps migrate
compose up -d --no-deps app
```

Setting `DATABASE_URL` instead of the parts and the owner's name works as well,
through an override file that adds it to the `migrate` service; the Compose
file still asks for `OWNER_DB_PASSWORD`, which is then not used. Three things
are required, and each deploy checks them before it grants anything, refusing
with a message that names what is wrong:

- **PostgreSQL 16 or later.** Each instance's owner creates that instance's
  runtime role, so it holds `CREATEROLE`. From 16 on, a role with `CREATEROLE`
  manages only the roles it created, so one instance's owner cannot alter
  another's runtime role. Before 16 it could. The owner may not be a superuser
  at all: the `migrate` service refuses to run as one.
- **A database owned by that instance's owner**, one owner per instance. Only
  the database's owner can close it to the other roles on the server; for any
  other role PostgreSQL would report the attempt as a warning and leave the
  database open.
- **A runtime role name of its own**, in `RUNTIME_DB_ROLE`. A role belongs to
  the whole server rather than to one database, so two instances naming the
  same role would each set its password on every start and grant it both
  databases. The entrypoint refuses, before anything connects, a name that is
  not a lower-case identifier of at most 63 characters, one that begins with
  `pg_`, one PostgreSQL reserves such as `public`, and the owner's own. The
  deploy refuses a role that another database already grants `CONNECT` to,
  because that role is another instance's.
  With `RUNTIME_DB_PASSWORD` set, a `DATABASE_URL_RUNTIME` you supply has to
  sign in as that same role, or the entrypoint refuses to start: the
  application would otherwise run as a role it never constrained. The
  connection limit the script sets for the role has to be 1 or more; `-1`
  would mean no limit.

A new database grants `CONNECT` to every role on the server. Each deploy that
constrains the runtime role revokes that grant on the instance's own database,
and checks afterwards that it is gone, so no instance's runtime role can open
a session on another's. The instance's own roles lose nothing: the runtime
role holds a grant of its own, and the owner owns the database. Any other role
that connects - a monitoring or a backup user - needs
`GRANT CONNECT ON DATABASE <database> TO <role>`, given by the owner.

That holds for the databases of instances that have started. A database no
instance has hardened yet, the server's own `postgres`, or another
application's database stays as its owner left it, open to every role on the
server, this instance's runtime role included. Only that database's owner can
close it, so a deploy does not refuse because of it. Create a new instance's
database and start that instance before putting data in it, and close the
databases of other applications yourself.

An instance that manages its runtime role itself, with `DATABASE_URL_RUNTIME`
and no `RUNTIME_DB_PASSWORD`, skips that step, so nothing revokes the grant for
it. Its owner runs `REVOKE CONNECT ON DATABASE <database> FROM PUBLIC` once, and
grants `CONNECT` to the runtime role and to any other role that connects.

The names of every role and every database on the server remain visible to all
of them whatever the grants, so neither should carry anything an association
would not want its neighbours to read. The server's own `postgres` database
still grants `CONNECT` to everyone; revoking that is the server
administrator's.

**Renaming the runtime role.** A start with a new `RUNTIME_DB_ROLE` constrains
the new role and leaves the old one as it was: still able to sign in, still
granted `CONNECT` and every table, and never constrained again when a later
migration adds one. Once the instance runs as the new role, the owner removes
the old one, in the instance's database:

```sql
GRANT openbrf_app TO openbrf_owner;  -- the owner; PostgreSQL 16 asks for it first
DROP OWNED BY openbrf_app;
DROP ROLE openbrf_app;
```

**Connections.** The application's pool holds up to
`OPENBRF_DATABASE_POOL_SIZE` connections, ten unless set, the job queue two
more, and installing or uninstalling a plugin or theme holds a lock on a
connection of its own, at most four at a time, so an instance can take sixteen
at the defaults. Each deploy limits the runtime role to that plus three, so an
instance - or code running inside it - cannot take more than its share.
PostgreSQL allows 100 connections unless `max_connections` says otherwise,
three of them reserved for superusers, which leaves room for five instances at
their limits and two connections over for the migrations each deploy runs and
for anybody else who connects. The limits,
and room for those, have to fit within `max_connections` less the reserved
connections; a smaller pool, or a larger `max_connections`, makes room for more
instances. A hosting service that gives each owner a `CONNECTION LIMIT` of its
own bounds the migrations as well.

## Backups

**The key is backed up once and kept apart; the database and the data volume are
backed up together, without it.** A backup without the encryption key cannot be
read: the encrypted columns and the stored files in it are unreadable for ever.
A backup that carries the key opens every one of them to whoever holds it.
[backup-and-restore.md](backup-and-restore.md) is the procedure, and it is worth
reading before the first member is added rather than after.

## Behind a reverse proxy

Bind the application to loopback - the default - and terminate TLS in front of
it, and name the proxy in `TRUSTED_PROXIES`. The client's address identifies it
for rate limiting on the authentication endpoints and on the forms an anonymous
visitor can submit, and behind a proxy it arrives only in `X-Forwarded-For`.

`TRUSTED_PROXIES` lists the addresses or CIDR ranges the proxy connects to the
application from, separated by commas. A proxy on the host that reaches the
port bound to loopback arrives from the gateway of the stack's Docker network,
which `docker network inspect openbrf-prod_default` shows; a proxy in a
container on that network arrives from its own address. The application reads
the header only on a request from one of these, and then only from the right,
past the hops the named proxies wrote: everything to the left of them is what
the client sent. So a proxy that appends to the header, as nginx's
`$proxy_add_x_forwarded_for` does, is as safe as one that overwrites it. The
forms and the sign-in endpoints count the same address, and a request sent to
the application's port directly, past the proxy, is counted by the address it
came from whatever header it carries.

Name only the proxies, never the clients. A client inside a listed range is
believed when it says which address it came from, so it can claim a new one for
every request and never run out of budget. Keep each range to the network the
proxy sits on; a range of every address, such as `0.0.0.0/0` or `::/0`, is
refused at start.

Left empty, the header is not read at all, and every visitor behind the proxy
shares its budget, on the forms and the sign-in endpoints alike: a busy
afternoon can then refuse a contact form to somebody who never sent one, and a
few failed sign-ins hold back everybody else's for a while.

The limits on a member exporting their own data - three a minute and one at a
time each, and twelve a minute for the whole instance - and the three reports
the instance gathers at once, shared between those exports and the board's data
subject access reports, and the four plugin and theme installs and uninstalls it
runs or queues at once, are counted in the memory of the application process, so
running more than one application container for an instance multiplies every
one of them by the number of containers.

## The data volume

`/data` holds the field encryption key, uploaded files, and installed plugins
and themes. It is mounted as the named volume `instance-data`.

The uploaded files on it are encrypted (ADR 0015), and the key sits beside them,
so a copy of the whole volume opens like the original. What keeps the two apart
is the backup procedure, which leaves the key out, or supplying the key through
`OPENBRF_ENCRYPTION_KEY` so that it is never on the volume at all. Against a
stolen disk, encrypt the host's disk: that is the operator's layer, and nothing
the instance can do for itself.

A named volume inherits the image's ownership and needs nothing else. A bind
mount does not: `chown` the host directory to uid 1000 first, or the container
refuses to start and says so.

## Mail

The instance sends invitations, sign-in links, notices and the board mailbox's
answers itself. Where they go out is decided in one of two places:

- **The board's own settings**, the default. The setup wizard and the settings
  screen take an SMTP server and a sender address, and the password is stored
  encrypted.
- **The environment**, for whoever runs the instance for the association.
  `OPENBRF_MAIL_DRIVER` set to `smtp` or `http-api` is used for every message,
  wins over anything the board stored, and locks the settings: the settings and
  the wizard show who sends the mail, through which host and from which address,
  and offer to send a test message but nothing to change. SMTP settings the board
  stored before stay where they are and apply again once `OPENBRF_MAIL_DRIVER` is
  empty.

| Variable                                     | When                         | Meaning                                                                                                                                                      |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENBRF_MAIL_DRIVER`                        | always                       | `settings` (empty or unset), `smtp` or `http-api`                                                                                                            |
| `OPENBRF_MAIL_FROM_ADDRESS`                  | `smtp`, `http-api`, required | the sender's bare address; it need not be on the association's own domain                                                                                    |
| `OPENBRF_MAIL_FROM_NAME`                     | `smtp`, `http-api`, optional | the display name, one line of at most 255 characters and not blank; unset, the association's registered name, read at each send                              |
| `OPENBRF_MAIL_REPLY_TO`                      | `smtp`, `http-api`, optional | where replies go when a message names nowhere of its own; unset, the board mailbox's published address while the board mailbox is configured, otherwise none |
| `OPENBRF_SMTP_HOST`                          | `smtp`, required             |                                                                                                                                                              |
| `OPENBRF_SMTP_PORT`                          | `smtp`, optional             | unset, 465 with `OPENBRF_SMTP_SECURE=true` and 587 without                                                                                                   |
| `OPENBRF_SMTP_SECURE`                        | `smtp`, optional             | implicit TLS, `true` or `false` exactly and anything else stops the instance at start; unset is `false`                                                      |
| `OPENBRF_SMTP_REQUIRE_TLS`                   | `smtp`, optional             | whether the sign-in waits for STARTTLS, `true` or `false` exactly; unset, it does unless the relay is on loopback. See "The SMTP relay" below                |
| `OPENBRF_SMTP_USER`, `OPENBRF_SMTP_PASSWORD` | `smtp`, both or neither      |                                                                                                                                                              |
| `OPENBRF_MAIL_API_URL`                       | `http-api`, required         | the service's base address, https or http on loopback, with no credentials, query or fragment; a path is allowed, and the instance posts to `<this>/emails`  |
| `OPENBRF_MAIL_API_KEY`                       | `http-api`, required         | the bearer key                                                                                                                                               |
| `OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN`         | `http-api`, required         | the domain the service writes its own `Message-ID` under, `<id>@<domain>`; `getpost.se` for Getpost                                                          |

For Getpost, `OPENBRF_MAIL_API_URL` is `https://api.getpost.se/v1`, and the key is
a sending key limited to the sending domain.

A variable of a driver other than the chosen one - an SMTP variable beside
`http-api`, or any of them while the driver is `settings` - stops the instance at
start with a message naming it. So does a required variable left out.
`docker-compose.prod.yml` maps every one of them, and `.env.production.example`
lists them under "Mail set where the instance runs". The key and the SMTP
password sit in the env file in plain text, as the S3 keys do: keep it where the
other secrets are kept.

**A sender that is not the association's.** A host may send every association's
mail from one domain it has verified. The association's registered name is then
the display name, and replies are directed to the board mailbox, so a
correspondent sees who wrote and answers the association rather than the shared
address. A message that names its own Reply-To keeps it. SPF, DKIM and DMARC for
the sending domain are the operator's to publish; the Reply-To needs no
alignment.

The registered name is the board's to change, so on a shared domain a board can
send under any name it types, another association's or an authority's, with
mail that passes the domain's checks. A host sharing one domain between
associations should set `OPENBRF_MAIL_FROM_NAME` on each instance, or use a
service that ties a display name to the key.

**The SMTP relay.** A connection to `OPENBRF_SMTP_HOST` that starts in cleartext
must upgrade through STARTTLS before the instance signs in, and a relay that does
not offer it is a failed send rather than a password sent in the clear. Only a
relay on this machine (`localhost`, `127.0.0.1`, `::1`) is exempt. Use port 465
with `OPENBRF_SMTP_SECURE=true` for implicit TLS instead.

A relay elsewhere that offers no STARTTLS, such as a Postfix sidecar on the
Compose network (`OPENBRF_SMTP_HOST=postfix`), needs
`OPENBRF_SMTP_REQUIRE_TLS=false`. The instance still upgrades when the relay
offers STARTTLS, but otherwise sends the sign-in and every message in the clear,
and so does it when something on the path removes the relay's offer. Set it only when you control every hop between the two, such as a network
that only these containers share. The instance logs a warning at start while it
is set. `OPENBRF_SMTP_REQUIRE_TLS=true` requires STARTTLS from a relay on
loopback too.

A server the board enters in the settings is held to the same rule, loopback
exemption included. Settings saved by an earlier version are moved to it by the
upgrade's migration, so a connection that starts in cleartext to a server that
offers no STARTTLS, which sent mail before the upgrade, sends none after it.
Implicit TLS is not affected, as the connection is encrypted from the start.
Every send through such a connection fails with the reason
`mail-tls-unavailable`, and nothing, the password included, is sent. Send a test
message from the SMTP card after upgrading. If it fails that way, have the board
switch to implicit TLS (usually port 465) or a port that offers STARTTLS (usually
587). Settings that do not require STARTTLS anyway, such as those a data-only
restore of an older backup brings back, are held to it all the same: the
instance requires STARTTLS of a server that is not on loopback when it sends,
whatever the stored settings say.

The relay must also deliver each message under the `Message-ID` the instance
gives it. The board mailbox recognises a correspondent's reply by that
identifier, and a relay that writes its own (Amazon SES's SMTP interface does)
leaves every reply outside its thread, with nothing in the log to say so. For a
service like that, use `http-api`, which records the identifier the service
answers with.

**The HTTP mail API.** The wire contract is ADR 0024's: a JSON document posted
with the bearer key and an `Idempotency-Key`, and never a `Message-ID`, which a
service of this shape writes itself. The board mailbox records the identifier
the service delivered each answer with, so a correspondent's reply to it joins
its thread. The instance sees no delivery events: what it knows is that the
service accepted the message.

The service mail goes through is a recipient of the association's personal
data. The data protection screen lists it by its host, the SMTP host or the mail
API's host, whichever the instance actually sends through.

## What the configuration says about processors

The association is the controller for the personal data on the instance
(GDPR art. 4(7)). What the deployment decides is who else touches it, and the
data protection screen reads the answer from this configuration rather than
asking the board to remember it:

- **The mail service.** A mailbox provider or mail API sending on the
  association's behalf is a processor and needs an agreement under art. 28. An
  SMTP server the association runs itself is not a separate recipient at all.
  It is named by the host mail actually goes through, whether the board entered
  it or the environment sets it (see "Mail").
- **The SMS provider.** The same, and an instance with none configured has no
  recipient there to classify.
- **File storage.** `local` keeps uploads on the instance's own volume and adds
  nobody; S3-compatible object storage is a recipient, and which one is read
  from the endpoint. The key never goes there, so what an object store receives
  from an instance that has always encrypted its files is ciphertext. An
  instance upgraded from a version that did not can still have plaintext in the
  bucket, in two shapes: a file the job at start could not encrypt, which stays
  as it was and which the instance refuses to serve, and the unencrypted object
  of a file it did encrypt, where the removal failed and a later start tries it
  again. Both are logged by file id, and the record of processing activities
  leaves out the sentence about encrypted files while either exists. It is a
  recipient in every case, because what it holds is the association's personal
  data. A bucket with versioning keeps every version the instance deletes - the
  plaintext objects the job replaced among them - so a removal is still not an
  erasure there.
- **The host.** Whoever runs the server the container runs on is a processor
  too, and the instance cannot know who that is - the board records it.
- **The board mailbox.** The mailbox the board's address is collected from over
  POP3 is an account at the association's mail provider, which holds every
  letter on its behalf and is a processor under art. 28. The instance never
  deletes a letter there, so a thread the nightly purge erases stays at the
  provider until the board deletes it.

Each of those appears on the data protection screen as a recipient to be
classified, with the agreement recorded against it. Changing the configuration
changes what the screen asks about; it never silently reclassifies a recipient
the board has already decided on.

The economic manager who is handed the debiting list and the accounting basis
has no setting on the instance, so the board records it as a recipient of its
own.

## The nightly purge

Service-tier personal data is erased on the retention policy's clock by jobs
that run between 03:05 and 03:53 UTC, spread across those minutes so they do not
wake together on one connection pool. They are ordinary queue jobs scheduled
once a night. An occurrence the instance was down for is skipped, not run when
it comes back, and a run that was interrupted is not resumed. Work the retention
clock is due does not go missing that way: every one of those jobs computes what
is due from residency dates and the policy rather than from a flag, so the next
night's run takes what the missed one would have. What is delayed is the erasure
itself. A retention deadline that fell in the gap is met a night late rather
than not at all, and an instance left down for several nights keeps that data
until it is running again at the time of the band.

A granted erasure request is selected by a flag rather than by a date, and the
03:53 job is the one that clears it. So that job closes a request only once it
has counted what each of the other jobs still holds for that person and found
nothing: a job that was interrupted, that threw for one person and carried on,
or that did not run at all leaves rows behind, and the request stays open for
the next night to finish. Where outstanding work is all the request is waiting
on, the person's contact details and account are erased that night and what
waits is the record, not the erasure.

Where something refuses the purge for that person, nothing of theirs is erased
at all. A legal hold, a restriction of processing, a board seat still held, a
system role still granted or a residency that has not ended each keeps them out
of the run: the job does not select them, and one recorded after it selected
them stops the transaction before it writes anything. Their request stays open
and the log says so, and the erasure has not started rather than being half
done. An open request is not by itself data that is partly gone - the reason on
the line is what says which it is.

A request left open says that reason in the container log, and the words mean
different things. "Blocked" is the product working, and it covers both cases
above, which the reason tells apart. A reason naming a rule - a legal hold, a
restriction, a board seat, a system role or a residency that has not ended -
means nothing of that person's went this night. A reason naming a domain and a
count means the erasure went as far as it goes and only the record is waiting; a
motion the association is still dealing with is the one case in the product,
because the member who put it has a right to have it treated at the meeting.
"Incomplete" is work that was owed and did not happen, and the next run takes
it. A request that stays incomplete night after night has two causes, and only
one of them leaves a trace: a job that keeps failing for that person logs the
failure beside it, while a job that did not run at all logs nothing, because a
missed occurrence is skipped rather than caught up afterwards. So check that
each of the jobs above ran, and not only that none of them reported a failure.
Looking for a log that was never written is how a granted erasure stays
outstanding for weeks while everybody believes it is in hand. Neither word says anything about
the person: "blocked" is the request waiting, not somebody whose personal data
is protected. The audit entry for a closing names the request and the domains
that were verified empty.

A run takes at most 500 people off its own retention window, and the people a
granted erasure request names are taken before that - all of them, whatever the
number, because somebody cut off the end of a run is somebody no later run would
select. So a run is 500 people, or as many as there are open granted requests
where that is more. The bound cuts the tail of the retention window and never
somebody the board granted an erasure to, and a run that reached it says so in
the container log.

The statutory registers and the audit log are outside all of it, and the
database refuses to update or delete a row in either.

A purge that fails on one person reports two things to the container log: the
class of the failure with the runtime's code for it, and the surrogate id this
application addresses that person by. Not their name, their contact details or
their personal identity number, nothing out of the rows being erased, and never
the exception's own message. The transaction that would have recorded the
erasure rolled back with it, so that line is the only trace of an erasure still
outstanding - which makes how long these logs are kept and who may read them
part of this instance's retention posture rather than an operational detail
beside it. ADR 0007 draws the boundary and says why it falls there.

## Plugins and themes

Plugins and themes are installed from the curated catalog: one index listing
both, kept in the public `openbrf/catalog` repository and read from the address
built into the instance,
`https://raw.githubusercontent.com/openbrf/catalog/main/catalog.json`. Leave
`OPENBRF_CATALOG_URL` empty. An address written there is compared exactly, and
any other spelling of the curated one is treated as an uncurated index and
refused.

To install, the instance needs outbound HTTPS on port 443 to three hosts:
`raw.githubusercontent.com` for the index, `github.com` for the release a listed
package is published on, and `release-assets.githubusercontent.com`, where a
release download is redirected. A running instance never contacts a package
registry; the installer works from tarballs whose sha512 the index states, and
checks it before anything is unpacked (see
[ADR 0003](adr/0003-plugin-loading-and-module-resolution.md) and
[ADR 0020](adr/0020-the-public-catalog-and-the-published-packages.md)).

Installing a plugin ends with the application process exiting, so that the next
start loads the plugin into it, and the instance depends on its supervisor to
start it again. `docker-compose.prod.yml` runs the application with
`restart: unless-stopped`; a deployment that starts the container another way
needs a restart policy that also covers a clean exit. Installing a theme
restarts nothing.

`OPENBRF_CATALOG_TOKEN` is for an index that requires a bearer token. It is sent
to the index, and to an artifact only when the artifact is on the index's own
origin: a package hosted anywhere else is fetched without it, so a host an
entry names never receives a token issued for the index. The curated catalog is
public and needs none.

Installing from sources outside the curated catalog is off by default, and
turning it on with `OPENBRF_UNCURATED_PLUGINS_ENABLED=true` is a deliberate
opt-out rather than a setting. The same flag is what permits an index or a
package read over plain http or from the instance's own filesystem.

## Connected apps

A member can point a program they chose - a chat client, an assistant - at the
instance and let it act as them, within what they may do themselves. This needs
nothing configured beyond a reachable `APP_URL`: the sign-in endpoints and the
discovery documents are served by every instance.

What it does need is a connector plugin installed, because the address such a
program actually talks to is that plugin's own route under `/api/plugin/`, not
one the platform serves itself. Only one installed plugin may serve it; a second
is refused at install, because the address is what every token already issued is
bound to and moving it would break every connection the members have granted.

Until a connector is installed, the instance advertises
`/api/plugin/mcp-connector/mcp` as the address and nothing is mounted there, so
discovery works and no program can connect.

`OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE` bounds what one connection may spend, and
defaults to 60. It is counted in memory per process, so it resets when the
instance restarts - and installing a plugin restarts it. It bounds what one
connection can do to an instance rather than being a quota anybody is billed
against.

Every connection is visible to the board under Connected apps, and the board can
cut one off; a member can see and cut their own. A disconnect takes effect on
the next call the app makes, not when its token would have expired.

An app the association does not want anybody to connect can be turned away for
the whole instance by somebody who may manage the association:
`DELETE /api/oauth-clients/<client id>`, with the client id as
`GET /api/connected-apps` lists it, cuts every member's connection to it and
refuses that client id at sign-in from then on, and the audit log records who
did it. There is no screen for it yet, and no way back: the database keeps a
disabled client disabled, whoever writes its row. A client registered by hand
can be registered again under a new id.

What is refused is the client id, not the program behind it. A program that
identifies itself by its metadata document can publish the same document at
another address and arrive as a new client; it then has no member's consent,
so nobody is connected to it until they agree again. To keep such a program
out for good, also limit the hosts below.

`OPENBRF_OAUTH_CLIENT_METADATA_HOSTS` narrows which programs can be connected in
the first place. A program usually identifies itself by the https address of
its own metadata document, and by default any public host may serve one. Listing
hosts, separated by commas, allows only those, matched exactly; it is checked
when a document is fetched, on a program's first connection and when its
document is refreshed, so a program already connected is turned away by
revoking it as above. A client an administrator registered by hand is not
affected.

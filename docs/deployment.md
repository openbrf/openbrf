# Running an Open BRF instance

One housing cooperative, one instance: an application container and a
PostgreSQL container, and nothing else to install.

> **Not yet ready to hold a housing cooperative's data.** See
> [ROADMAP.md](../ROADMAP.md) for what is actually built. This document
> describes how the instance runs, not that it is ready to run.

## What you need

- Docker with Compose v2
- A machine reachable at the public https:// address members will use, with TLS
  in front of it. Passkeys need a secure origin, and so does a session cookie
  that is worth anything.

## Starting an instance

```sh
git clone https://github.com/openbrf/openbrf.git
cd openbrf
cp .env.production.example .env.production
```

Fill in the four values `.env.production` asks for, generating each with

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Any character is allowed in the two database passwords. They end up inside
PostgreSQL connection URLs, where `:`, `/`, `@`, `?` and `#` are delimiters, and
the entrypoint percent-encodes them as it builds those URLs.

Set `APP_URL` to the public https:// address members will use. Invitation and
sign-in links are built from it, and the session cookie is issued for it, so a
wrong value here produces links that go nowhere. It is the origin and nothing
more: the association's own website is served at that address, and the
application at `/app` below it.

Then:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Open `APP_URL`. An unclaimed instance sends every visitor to the setup wizard,
which creates the first administrator account, the housing cooperative, its
addresses and its apartments, the email settings and the accent colour.
Everything after the administrator account and the name can be skipped and
finished later in settings.

The wizard is public only while the instance is unclaimed - no account exists
and setup has never been completed - and admin-only from its second screen
onwards.

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

## What happens on every start

The entrypoint runs, in this order, before the application listens:

1. The application's connection URL is assembled from the host, the port, the
   database name and the runtime role's password, percent-encoding as it goes.
   A `DATABASE_URL_RUNTIME` that is already set is left alone. The owner's URL
   is built the same way, but separately for each of steps 3 to 6 and inside the
   process that uses it, so it is never a variable in the entrypoint's shell and
   is never written to a stream. A `DATABASE_URL` that is already set is used as
   given.
2. The data volume's directories are created and checked for writability.
3. The field encryption key is provisioned if, and only if, this is a genuine
   first boot. See [ADR 0004](adr/0004-encryption-key-provisioning.md) and
   [backup-and-restore.md](backup-and-restore.md).
4. Database migrations are applied, as the schema owner.
5. The job queue schema is installed or migrated, as the owner.
6. The application's own database role, `openbrf_app`, is created and
   constrained.
7. The owner's credentials are dropped from the environment, and the
   application starts, connecting as `openbrf_app`.

Steps 4 to 6 are idempotent, so upgrading is a newer image and the same `up -d`
that started the instance.

There is no published image yet, so the image is built from the checkout. A
`pull` has no registry to fetch it from and fails; an `up -d` on its own does
not rebuild an image that already exists. The build is therefore its own step:

```sh
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Once an image is published, the `git pull` and the `build` become one `pull`:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Both selectors belong on every one of those commands. Without
`-f docker-compose.prod.yml`, Compose picks up the `docker-compose.yml` in this
repository instead, which defines the development database and no application
at all: the upgrade would touch the wrong volumes and leave the running
instance on its old image.

## Two database roles, and why

The member register and the audit log are append-only, enforced by triggers in
the database rather than by application code alone. A table's owner can run
`ALTER TABLE ... DISABLE TRIGGER` and walk straight past them, so the
application must not be the owner.

`openbrf` owns the schema and runs migrations. `openbrf_app` owns nothing, holds
no `CREATE` privilege, and has `UPDATE` and `DELETE` revoked on the statutory
tables. The entrypoint creates and constrains it from `RUNTIME_DB_PASSWORD` on
every start, so the privileges are reapplied after any migration that added a
table.

The owner's credentials never reach the server. Neither password is passed as a
process argument - `/proc/<pid>/cmdline` is readable by every process in the
container, and the environment is not - and `DATABASE_URL`, `POSTGRES_PASSWORD`
and `RUNTIME_DB_PASSWORD` are removed from the environment after step 6, so the
process that answers requests carries `DATABASE_URL_RUNTIME` and no other
database credential. A compromise of the application therefore has no owner
connection to reach for, and the append-only guards on the member register and
the audit log stay beyond it.

An operator who manages that role themselves can leave `RUNTIME_DB_PASSWORD`
empty in `.env.production` and set `DATABASE_URL_RUNTIME` there instead; the
entrypoint then skips step 6 and constrains nothing, so the role has to be
granted no more than
[harden-runtime-role.sql](../apps/api/prisma/sql/harden-runtime-role.sql) grants
it. A `DATABASE_URL_RUNTIME` supplied that way is used as written, so its
password has to be percent-encoded already.

Neither variable is required by the Compose file, because requiring either one
would make the other impossible to use. The entrypoint is what refuses a
production start that has neither, because the alternative is an application
connecting as the owner - so that refusal, rather than a missing value in the
env file, is the error an operator who has set up neither will read.

## Backups

**The database and `/data/keys` are one unit.** A database backup without the
encryption key is not a backup: the encrypted columns cannot be read again, ever.
[backup-and-restore.md](backup-and-restore.md) is the procedure, and it is worth
reading before the first member is added rather than after.

## Behind a reverse proxy

Bind the application to loopback - the default - and terminate TLS in front of
it. The proxy must set `X-Forwarded-For` itself rather than passing through
whatever a client sends: the header identifies the client for rate limiting on
the authentication endpoints and on the forms an anonymous visitor can submit,
and a client that can set it can spoof its way around both.

## The data volume

`/data` holds the field encryption key, uploaded files, and installed plugins
and themes. It is mounted as the named volume `instance-data`.

A named volume inherits the image's ownership and needs nothing else. A bind
mount does not: `chown` the host directory to uid 1000 first, or the container
refuses to start and says so.

## Plugins and themes

`OPENBRF_CATALOG_URL` points at the curated catalog. While the catalog
repository is private, before public launch, `OPENBRF_CATALOG_TOKEN` carries the
bearer token used for both the index and the release tarballs it points at. A
running instance never authenticates to a package registry; the installer works
from tarballs (see [ADR 0003](adr/0003-plugin-loading-and-module-resolution.md)).

Installing from sources outside the curated catalog is off by default, and
turning it on is a deliberate opt-out rather than a setting.

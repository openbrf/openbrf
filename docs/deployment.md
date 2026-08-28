# Running an Open BRF instance

One housing cooperative, one instance: an application container and a
PostgreSQL container, and nothing else to install.

> **Not yet ready to hold a housing cooperative's data.** See
> [ROADMAP.md](../ROADMAP.md) for what is actually built. This document
> describes how the instance runs, not that it is ready to run.

## What you need

- Docker with Compose v2
- A machine that can reach the address members will type, with TLS in front of
  it. Passkeys need a secure origin, and so does a session cookie that is worth
  anything.

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

Hex is not a style preference: these go into PostgreSQL connection URLs, where a
password containing `:`, `/`, `@`, `?` or `#` must be percent-encoded and fails
authentication silently when it is not.

Set `APP_URL` to the address members will type. Invitation and sign-in links are
built from it, and the session cookie is issued for it, so a wrong value here
produces links that go nowhere.

Then:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Open `APP_URL`. The first visitor gets the setup wizard, which creates the first
administrator account, the housing cooperative, its addresses and its
apartments, the email settings and the accent colour. Everything after the
administrator account and the name can be skipped and finished later in
settings.

The wizard is public only while the instance is unclaimed - no account exists
and setup has never been completed - and admin-only from its second screen
onwards.

## What happens on every start

The entrypoint runs, in this order, before the application listens:

1. The data volume's directories are created and checked for writability.
2. The field encryption key is provisioned if, and only if, this is a genuine
   first boot. See [ADR 0006](adr/0006-encryption-key-provisioning.md) and
   [backup-and-restore.md](backup-and-restore.md).
3. Database migrations are applied, as the schema owner.
4. The job queue schema is installed or migrated, as the owner.
5. The application's own database role, `openbrf_app`, is created and
   constrained.
6. The application starts, connecting as `openbrf_app`.

Steps 3 to 5 are idempotent, so upgrading is `docker compose pull` - or
`docker compose build` while there is no published image - followed by
`docker compose up -d`, and nothing else.

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

An operator who manages that role themselves can leave `RUNTIME_DB_PASSWORD`
unset and set `DATABASE_URL_RUNTIME` instead; the entrypoint then skips step 5.
It refuses to start with neither, because the alternative is an application
connecting as the owner.

## Backups

**The database and `/data/keys` are one unit.** A database backup without the
encryption key is not a backup: the encrypted columns cannot be read again, ever.
[backup-and-restore.md](backup-and-restore.md) is the procedure, and it is worth
reading before the first member is added rather than after.

## Behind a reverse proxy

Bind the application to loopback - the default - and terminate TLS in front of
it. The proxy must set `X-Forwarded-For` itself rather than passing through
whatever a client sends: the header identifies the client for rate limiting on
the authentication endpoints, and a client that can set it can spoof its way
around them.

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

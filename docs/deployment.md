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

## What the configuration says about processors

The association is the controller for the personal data on the instance
(GDPR art. 4(7)). What the deployment decides is who else touches it, and the
data protection screen reads the answer from this configuration rather than
asking the board to remember it:

- **The SMTP server.** A mailbox provider sending on the association's behalf
  is a processor and needs an agreement under art. 28. An SMTP server the
  association runs itself is not a separate recipient at all.
- **The SMS provider.** The same, and an instance with none configured has no
  recipient there to classify.
- **File storage.** `local` keeps uploads on the instance's own volume and adds
  nobody; S3-compatible object storage is a recipient, and which one is read
  from the endpoint.
- **The host.** Whoever runs the server the container runs on is a processor
  too, and the instance cannot know who that is - the board records it.

Each of those appears on the data protection screen as a recipient to be
classified, with the agreement recorded against it. Changing the configuration
changes what the screen asks about; it never silently reclassifies a recipient
the board has already decided on.

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
the next night to finish. The person's contact details and account are erased
that night either way - what waits is the record saying the erasure was carried
out, not the erasure.

A request left open says why in the container log, and the two reasons mean
different things. "Protected" is the product working: a legal hold, a
restriction, a board seat, a system role, a residency that has not ended or a
motion the association is still dealing with is keeping rows the purge must not
take, and the request waits for that to change rather than for anybody.
"Incomplete" is work that was owed and did not happen, and the next run takes
it; a request that stays incomplete night after night is a job that keeps
failing, and the failure is logged beside it. The audit entry for a closing
names the request and the domains that were verified empty.

Each of these jobs takes at most 500 people in one run. The people a granted
erasure request names are taken first, so the bound cuts the tail of the
retention window and never somebody the board granted an erasure to; a run that
reached its bound says so in the container log.

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

`OPENBRF_CATALOG_URL` points at the curated catalog. While the catalog
repository is private, before public launch, `OPENBRF_CATALOG_TOKEN` carries the
bearer token used for both the index and the release tarballs it points at. A
running instance never authenticates to a package registry; the installer works
from tarballs (see [ADR 0003](adr/0003-plugin-loading-and-module-resolution.md)).

Installing from sources outside the curated catalog is off by default, and
turning it on is a deliberate opt-out rather than a setting.

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

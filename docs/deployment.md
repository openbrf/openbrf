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
four secrets it asks for, generating each with

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
6. The application's own database role is created and constrained: `openbrf_app`,
   or the name `RUNTIME_DB_ROLE` gives it.
7. The owner's credentials are dropped from the environment, and the
   application starts, connecting as that role. Its first line after listening
   names the release and the commit it was built from, as
   `Open BRF 0.1.0 (1a2b3c4d5e6f)`.

The start is refused before anything connects when `RUNTIME_DB_ROLE` cannot be
a runtime role's name: see
[Several instances on one database server](#several-instances-on-one-database-server).

Steps 4 to 6 are idempotent, so upgrading is a newer image and the same `up -d`
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

**What a failed migration leaves.** The entrypoint stops at the first error and
the container exits with a non-zero status. With `restart: unless-stopped` it
is started again and fails the same way. The failing migration is rolled back
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
   its start period and, where the [management API](#the-management-api) is
   configured, its summary names the target's `version` and has
   `migrations.failed` and `migrations.pending` at 0.
4. Otherwise, stop it, restore both halves of the backup, and start the
   previous image by its digest.

## Two database roles, and why

The member register and the audit log are append-only, enforced by triggers in
the database rather than by application code alone. A table's owner can run
`ALTER TABLE ... DISABLE TRIGGER` and walk straight past them, so the
application must not be the owner.

`openbrf` owns the schema and runs migrations. The runtime role - `openbrf_app`,
unless `RUNTIME_DB_ROLE` names another - owns nothing, holds no `CREATE`
privilege, and has `UPDATE` and `DELETE` revoked on the statutory tables. The
entrypoint creates and constrains it from `RUNTIME_DB_PASSWORD` on every start,
so the privileges are reapplied after any migration that added a table.

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

## Several instances on one database server

One PostgreSQL server can hold the databases of several instances. Each is
still a container of its own, with its own data volume and its own key, and
reaches the server through `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB` and
`POSTGRES_USER` beside its two passwords - the variables
`docker-compose.prod.yml` sets for its own database - or through a
`DATABASE_URL`. Three things are then required:

- **PostgreSQL 16 or later.** Each instance's owner creates that instance's
  runtime role, so it holds `CREATEROLE`, and on a shared server it is not a
  superuser. From 16 on, a role with `CREATEROLE` manages only the roles it
  created, so one instance's owner cannot alter another's runtime role. Before
  16 it could.
- **A database owned by that instance's owner**, one owner per instance. The
  owner runs the migrations and constrains the runtime role in its own
  database.
- **A runtime role name of its own**, in `RUNTIME_DB_ROLE`. A role belongs to
  the whole server rather than to one database, so two instances naming the
  same role would each set its password on every start and grant it both
  databases. The entrypoint refuses, before anything connects, a name that is
  not a lower-case identifier of at most 63 characters, one that begins with
  `pg_`, and the owner's own.

A new database grants `CONNECT` to every role on the server, and each start
revokes that grant on the instance's own database, so no instance's runtime
role can open a session on another's. The instance's own roles lose nothing:
the runtime role holds a grant of its own, and the owner owns the database.
Any other role that connects - a monitoring or a backup user - needs
`GRANT CONNECT ON DATABASE <database> TO <role>`, given by the owner. The names
of every role and every database on the server remain visible to all of them
whatever the grants, so neither should carry anything an association would not
want its neighbours to read.

**Connections.** The application's pool holds up to
`OPENBRF_DATABASE_POOL_SIZE` connections, ten unless set, and the job queue two
more, so an instance can take twelve at the defaults. PostgreSQL allows 100
connections unless `max_connections` says otherwise, three of them reserved for
superusers, which leaves room for eight instances at their defaults and one
connection over - too few for the migrations each start runs and for anybody
else who connects. The pool sizes plus two for each instance, and room for
those, have to fit within `max_connections` less the reserved connections; a
smaller pool, or a larger `max_connections`, makes room for more instances.

## Backups

**The key is backed up once and kept apart; the database and the data volume are
backed up together, without it.** A backup without the encryption key cannot be
read: the encrypted columns and the stored files in it are unreadable for ever.
A backup that carries the key opens every one of them to whoever holds it.
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

The uploaded files on it are encrypted (ADR 0015), and the key sits beside them,
so a copy of the whole volume opens like the original. What keeps the two apart
is the backup procedure, which leaves the key out, or supplying the key through
`OPENBRF_ENCRYPTION_KEY` so that it is never on the volume at all. Against a
stolen disk, encrypt the host's disk: that is the operator's layer, and nothing
the instance can do for itself.

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

## The management API

Whoever hosts an instance can read a summary of it - the apartment count, the
size of the registers, whether residents have been invited, the day the board
was last active, storage, the version and the state of the migrations - and
nothing about any one person. It is off unless `OPENBRF_MANAGEMENT_PORT` and
`OPENBRF_MANAGEMENT_TOKEN_DIGEST` are both set, it listens on that port of its
own and never on the public address, and every read is written to the audit
log. The port is never published.

[management-api.md](management-api.md) says how to enable it, how to mint and
rotate its token, and what each field of the summary is.

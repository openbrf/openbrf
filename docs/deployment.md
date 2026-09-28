# Running an Open BRF instance

One housing cooperative, one instance: an application container and a
PostgreSQL container, a migrate container that prepares the database on every
deploy and exits, and nothing else to install.

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

Fill in the five values `.env.production` asks for, generating each with

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

## What happens on every deploy

Every `up` runs the `migrate` service first. It is the same image as the
application, started with `migrate`, and it does, in this order:

1. The data volume's directories are created and checked for writability.
2. The schema owner's connection is checked: it has to work, and it must not be
   a superuser.
3. The field encryption key is provisioned if, and only if, this is a genuine
   first boot. See [ADR 0004](adr/0004-encryption-key-provisioning.md) and
   [backup-and-restore.md](backup-and-restore.md).
4. Database migrations are applied, as the schema owner.
5. The job queue schema is installed or migrated, as the owner.
6. The application's own database role, `openbrf_app`, is created and
   constrained.

Then it exits, and the application starts only if it succeeded. The owner's URL
is built separately for each of steps 2 to 6, inside the process that uses it,
so it is never a shell variable and never written to a stream; a `DATABASE_URL`
that is set on the `migrate` service is used as given.

The application's container assembles its own connection URL from the runtime
role's password and starts. It is never given the owner's credentials, and it
refuses to start if it is: a `POSTGRES_PASSWORD`, an `OWNER_DB_PASSWORD`, or a
`DATABASE_URL` beside the runtime connection stops it with a message that says
which. Once started, it asks the database whether the role it connected as is
a constrained one, and refuses to serve if the answer is no - a superuser, a
role that owns the database or its tables, or one that can rewrite the member
register, the audit log or the migration history.

Every step is idempotent, so upgrading is a newer image and the same `up -d`
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

## Three database roles, and why

The member register and the audit log are append-only, enforced by triggers in
the database rather than by application code alone. A table's owner can run
`ALTER TABLE ... DISABLE TRIGGER` and walk straight past them, so the
application must not be the owner. And migrations need to own the tables and
nothing more, so the role that runs them must not be a superuser.

| Role            | What it is                                                                                                                                                                                                                                                                                                             | Password              | Given to                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------- |
| `openbrf`       | The superuser the database image creates.                                                                                                                                                                                                                                                                              | `POSTGRES_PASSWORD`   | the `db` container only |
| `openbrf_owner` | Owns the database, its schemas and its tables, and runs migrations. Not a superuser; its one attribute is `CREATEROLE`, which on PostgreSQL 16 and later reaches only `openbrf_app`. Created on the first start of an empty volume by [10-schema-owner.sql](../docker/db/initdb/10-schema-owner.sql).                  | `OWNER_DB_PASSWORD`   | `db` and `migrate`      |
| `openbrf_app`   | The application's connection. Owns nothing, creates nothing, and has `UPDATE` and `DELETE` revoked on the statutory tables and every write revoked on the migration history. Created and constrained by the `migrate` service on every deploy, so the privileges are reapplied after any migration that added a table. | `RUNTIME_DB_PASSWORD` | `migrate` and `app`     |

The owner's credentials never reach the application's container. Neither
password is passed as a process argument - `/proc/<pid>/cmdline` is readable by
every process in a container, and the environment is not - and the owner's is
given to the `migrate` service alone, which exits once the deploy steps have
run. The application's container runs with a read-only root filesystem, no
capabilities and `no-new-privileges`, and the code in it is owned by root: the
user the application runs as can write to `/data` and `/tmp` and nowhere else.

An operator who manages the runtime role themselves can leave
`RUNTIME_DB_PASSWORD` empty in `.env.production` and set `DATABASE_URL_RUNTIME`
there instead; the `migrate` service then skips step 6 and constrains nothing,
so the role has to be granted no more than
[harden-runtime-role.sql](../apps/api/prisma/sql/harden-runtime-role.sql) grants
it. A `DATABASE_URL_RUNTIME` supplied that way is used as written, so its
password has to be percent-encoded already, and the application's own check at
start is what catches one that names the wrong role. That check also refuses a
role that can write the migration history, which a role granted everything in
`public` by an earlier release can; an instance that upgrades has to take that
away first ("Upgrading to a separate schema owner", below).

Neither variable is required by the Compose file, because requiring either one
would make the other impossible to use. The entrypoint is what refuses a
production start that has neither, because the alternative is an application
connecting as the owner - so that refusal, rather than a missing value in the
env file, is the error an operator who has set up neither will read.

## Upgrading to a separate schema owner

An instance installed before `openbrf_owner` existed ran its migrations as the
superuser, which owns every table. It moves to the separate owner once, by
hand; every deploy after that is the ordinary `build` and `up -d`.

```sh
compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
}

# 1. Take a backup first (backup-and-restore.md).

# 2. Fetch the release, and add the owner's password to .env.production,
#    generated like the others:
#      OWNER_DB_PASSWORD="..."
git pull

# 3. Build the new image, and recreate the database container so it is given
#    OWNER_DB_PASSWORD. The running application keeps serving meanwhile.
compose build
compose up -d db

# 4. Create openbrf_owner and give it the database, its schemas and everything
#    in them. Runs as the superuser, inside the database container.
compose exec -T db \
  psql -U openbrf -d openbrf -f /docker-entrypoint-initdb.d/10-schema-owner.sql

# 5. Deploy as usual. The migrate service now connects as openbrf_owner.
compose up -d
```

Step 4 is the same script the database runs on the first start of an empty
volume, and it is safe to run again. Skipping it leaves the `migrate` service
unable to log in, and it stops and names this section rather than starting the
application. A `migrate` service that finds itself connected as a superuser -
a `DATABASE_URL` pointed at one - stops the same way.

Step 4 also revokes any role that `openbrf_app` has been made a member of. Such
a membership lends it privileges that no revoke on `openbrf_app` reaches, and
only the superuser can take back a membership the superuser granted, so the
`migrate` service refuses to harden the role while one is left and names this
script.

If you manage the runtime role yourself (`DATABASE_URL_RUNTIME` set,
`RUNTIME_DB_PASSWORD` empty), the `migrate` service does not touch it, and a
role that was granted every write in `public` by an earlier release can still
write the migration history. The application refuses to start as such a role,
so constrain it before step 5.

If it is `openbrf_app`, apply
[harden-runtime-role.sql](../apps/api/prisma/sql/harden-runtime-role.sql) to it
again as the owner, after step 4, from the checkout. The script also sets the
role's password, from `RUNTIME_DB_PASSWORD`, so give it the password your
`DATABASE_URL_RUNTIME` already uses. The variable is set in your shell only and
handed to the container by name, which keeps it out of the process arguments;
`.env.production` keeps `RUNTIME_DB_PASSWORD` empty.

```sh
read -rs RUNTIME_DB_PASSWORD && export RUNTIME_DB_PASSWORD
compose exec -T -e RUNTIME_DB_PASSWORD db \
  psql -U openbrf_owner -d openbrf -f - < apps/api/prisma/sql/harden-runtime-role.sql
unset RUNTIME_DB_PASSWORD
```

Otherwise revoke the three privileges the release took away, as the superuser,
naming your role. pg-boss's maintenance stamps the times it ran on the
`pgboss.version` row, so the last statement grants `UPDATE` back on every
column of that table except `version`, read from the catalog as the hardening
script does. Without it, the application's maintenance fails.

```sh
compose exec -T db psql -U openbrf -d openbrf -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
REVOKE ALL ON public._prisma_migrations FROM my_runtime_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pgboss.version FROM my_runtime_role;
REVOKE CREATE ON SCHEMA pgboss FROM my_runtime_role;
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

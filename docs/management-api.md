# The management API

A read-only summary of an instance for whoever hosts it: how many apartments it
has, how many people its registers hold, whether residents have been invited,
the day the board was last active, how often the register extracts have been
generated, the storage it uses, the version it runs and the state of its
database migrations. It carries nothing about any one person. It is off unless
the operator configures it, answers on a port of its own that the public
address never reaches, and every read is written to the association's audit
log.

This page is for an operator enabling it and for whoever writes the program
that reads it. [ADR 0021](adr/0021-the-management-api.md) records why it is
built this way.

## Enabling it

Two variables, both required, in the application container's environment:

| Variable                          | Value                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENBRF_MANAGEMENT_PORT`         | The port the listener binds inside the container, 1024 to 65535, and not the application's `PORT`.                                               |
| `OPENBRF_MANAGEMENT_TOKEN_DIGEST` | The SHA-256 digest of the token, base64url without padding (43 characters), or two such digests separated by a comma while the token is rotated. |

Setting one without the other, a port equal to `PORT`, or a value of the wrong
shape stops the instance at start with a message naming the variable. With
neither set there is no listener at all. When the listener starts, the log says
so on one line naming the port.

`docker-compose.prod.yml` passes neither variable to the container, so an
operator running that file adds them in a file of their own beside it, for
example `docker-compose.management.yml`:

```yaml
services:
  app:
    environment:
      OPENBRF_MANAGEMENT_PORT: "3001"
      OPENBRF_MANAGEMENT_TOKEN_DIGEST: ${OPENBRF_MANAGEMENT_TOKEN_DIGEST:?set the digest in the env file}
```

with the digest in `.env.production`, and starts both files together:

```sh
docker compose -f docker-compose.prod.yml -f docker-compose.management.yml \
  --env-file .env.production up -d
```

**Never publish the port.** The file above has no `ports:` entry, and it must
not gain one. The listener is meant to be reached only from where the host's
own systems are: another container on the same Docker network, which reaches it
as `app:3001`, or a private network between servers. Nothing encrypts the
connection, and a token is all that stands between a published port and the
summary.

## The token

The token is minted by whoever reads the summary and kept by them. The instance
is given only its digest, so nothing in the instance's environment, database or
backups can be presented as the token.

One command prints a new token and its digest:

```sh
node -e "const c=require('node:crypto'); const t=c.randomBytes(32).toString('base64url'); console.log('token  '+t); console.log('digest '+c.createHash('sha256').update(t,'utf8').digest('base64url'))"
```

The token goes to the program that reads the summary; the digest goes into
`OPENBRF_MANAGEMENT_TOKEN_DIGEST`.

### Rotating it

1. Mint a new token. Set `OPENBRF_MANAGEMENT_TOKEN_DIGEST` to the new digest and
   the old one, separated by a comma, and restart the instance. Both tokens
   work.
2. Move the reading program to the new token.
3. At the next restart, set only the new digest. The old token stops working.

The environment changes only on a restart, and while both digests are set it
does not matter which side moves first.

## The request

```http
GET /v1/summary HTTP/1.1
Host: app:3001
Authorization: Bearer <token>
```

The scheme is matched in any case. That route is the whole of the API.

| Answer | Body                                       | When                                                                                                                                                                   |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | the summary                                | The token matches a configured digest and the budget allows it.                                                                                                        |
| 401    | `{ "reason": "management-token-invalid" }` | No Authorization header, two of them, another scheme, or a token matching no digest. Which of these it was is not said. The answer carries `WWW-Authenticate: Bearer`. |
| 404    | `{ "reason": "not-found" }`                | Any other path, and any method on `/v1/summary` other than `GET`, whatever the token.                                                                                  |
| 429    | `{ "reason": "rate-limited" }`             | More than ten reads in a minute with one token. `Retry-After` says how many seconds to wait.                                                                           |
| 500    | `{ "reason": "summary-unavailable" }`      | The summary could not be read. The instance's log names the failure.                                                                                                   |

Every answer carries `Cache-Control: no-store`. A request body is never read.

The budget is ten reads a minute per configured digest, counted in the
instance's process and reset when it restarts. A reader needs a handful a day:
once a day, once after an upgrade, once when invoicing.

## The summary

```json
{
  "schema": 1,
  "version": "0.2.0",
  "revision": "4f1c2d0e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
  "migrations": {
    "shipped": 95,
    "applied": 95,
    "failed": 0,
    "pending": 0,
    "latest": "20260913276000_management_audit_vocabulary"
  },
  "claimed": true,
  "apartments": 42,
  "register": {
    "persons": 97,
    "members": 51,
    "residents": 88,
    "boardSeats": 5,
    "administrators": 2
  },
  "invitedResidents": 14,
  "boardActivityOn": "2027-02-11",
  "registerExtracts": { "memberRegister": 3, "apartmentRegister": 1 },
  "storage": { "storedFileBytes": 48213377, "databaseBytes": 21890203 },
  "health": { "database": "ok", "pluginFindings": 0 }
}
```

| Field                                | What it is                                                                                                                                                                                                                                                                                       | Read from                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `schema`                             | The document's version: 1.                                                                                                                                                                                                                                                                       | A constant.                                                                                |
| `version`                            | The platform version the instance runs.                                                                                                                                                                                                                                                          | `apps/api/package.json`, which the image workflow requires to equal the release tag.       |
| `revision`                           | The commit the image was built from, or `null` outside a published image.                                                                                                                                                                                                                        | The image's `OPENBRF_REVISION`.                                                            |
| `migrations.shipped`                 | How many migrations the image carries.                                                                                                                                                                                                                                                           | The image's `prisma/migrations`, listed once at start.                                     |
| `migrations.applied`                 | How many the database has applied.                                                                                                                                                                                                                                                               | `_prisma_migrations`: finished and not rolled back.                                        |
| `migrations.failed`                  | How many started and neither finished nor were rolled back. Anything above 0 is a start that failed part way, and every later start refuses until it is resolved.                                                                                                                                | `_prisma_migrations`.                                                                      |
| `migrations.pending`                 | How many the image carries that the database has not applied.                                                                                                                                                                                                                                    | Both of the above.                                                                         |
| `migrations.latest`                  | The newest applied migration's name, or `null`.                                                                                                                                                                                                                                                  | `_prisma_migrations`.                                                                      |
| `claimed`                            | Whether setup has been completed.                                                                                                                                                                                                                                                                | The association's setup completion.                                                        |
| `apartments`                         | Every apartment in the register: the billing basis. An apartment is deleted rather than retired, so the rows are the apartments there are.                                                                                                                                                       | The apartment table.                                                                       |
| `register.persons`                   | Every person in the register.                                                                                                                                                                                                                                                                    | The person table.                                                                          |
| `register.members`                   | Persons holding a member's residency today.                                                                                                                                                                                                                                                      | Residencies held on the association's day.                                                 |
| `register.residents`                 | Persons holding any residency today.                                                                                                                                                                                                                                                             | The same.                                                                                  |
| `register.boardSeats`                | Board seats held today.                                                                                                                                                                                                                                                                          | Board positions held on the association's day.                                             |
| `register.administrators`            | Persons holding the administrator role.                                                                                                                                                                                                                                                          | System roles.                                                                              |
| `invitedResidents`                   | Persons who hold a residency today, hold no board seat today and no system role, and have an account or an invitation neither accepted nor expired. A resident later elected to the board leaves the count.                                                                                      | Accounts and invitations.                                                                  |
| `boardActivityOn`                    | The latest day, `YYYY-MM-DD` on the association's calendar, on which a person holding a board seat or the administrator role today renewed a session or acted through the web interface, a connected app, the AI package or a plugin, or through no recorded channel. `null` when there is none. | Sessions, which are renewed at most once a day and deleted on sign-out, and the audit log. |
| `registerExtracts.memberRegister`    | How many times the member register extract was generated, through the same channels.                                                                                                                                                                                                             | The audit log.                                                                             |
| `registerExtracts.apartmentRegister` | The same for the apartment register extract.                                                                                                                                                                                                                                                     | The audit log.                                                                             |
| `storage.storedFileBytes`            | The size of every stored file as it was uploaded. On the volume each is 17 bytes larger per 64 KiB, and plugins and themes are not counted.                                                                                                                                                      | The stored files' records.                                                                 |
| `storage.databaseBytes`              | The size of the instance's database.                                                                                                                                                                                                                                                             | `pg_database_size`.                                                                        |
| `health.database`                    | `"ok"`: the summary was read in a transaction that committed.                                                                                                                                                                                                                                    | The read itself.                                                                           |
| `health.pluginFindings`              | How many findings the plugins screen shows: plugins that were refused or dropped when the instance started.                                                                                                                                                                                      | The plugin loader.                                                                         |

The register is counted from its own tables. Persons with protected personal
data and persons whose processing is restricted are counted like everybody
else, which the figures a plugin or a resident is given do not do: a protected
member is a member, and their apartment is billed like any other.

"Generated" is not "printed". Printing an extract is the browser's; the entry
counted here is written each time the extract is served to somebody.

What the instance does on its own - the nightly jobs, and the reads of this
summary - is never the board's activity and never an extract: those channels
are left out of both.

### What is never in it

No identifier, name, date of birth, personal identity number, address,
apartment number, email address or telephone number, and no row per person. The
only fact in time is `boardActivityOn`, which is a day, not a moment and not
whose. A field that would name or count one person is not added.

## The audit entry

Every successful read is written to the association's audit log as
`INSTANCE_SUMMARY_READ` on the audit channel `MANAGEMENT`, with no actor and no
target, and `{ "schema": 1 }` as its context. It is written in the same
transaction as the summary, so there is no summary without its entry and no
entry for a summary that was not returned. A refused request writes nothing. The
entry names nobody, so it appears on no data subject access report; it is how
the association's own log shows when its host read what.

## The version rule

A field added to the summary keeps `schema` at 1, and a reader ignores fields it
does not know. A field removed, or one whose meaning changes, is a new document
at `/v2/summary`, and `/v1/summary` keeps answering until the readers have
moved. Removing a document version is a major release after 1.0
([CONTRIBUTING.md](../CONTRIBUTING.md), "Releasing the platform").

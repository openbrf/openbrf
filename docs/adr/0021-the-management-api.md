# ADR 0021: The management API

Date: 2026-09-27

## Status

Accepted

## Context

Whoever hosts an instance needs a few facts about it that only the instance
holds. The hosting service bills per apartment, read from the instance's own
register (Beslutslogg 68). Its trial ends when the first resident is invited,
and it sends an inactivity notice after thirty days without board activity; it
watches the size of the registers and how often their extracts are produced for
a signal a person then looks at (Beslutslogg 69). And it upgrades the instance,
which it can only call a success once it knows which version answers and
whether the migrations ran.

None of that may reach the association's personal data. The hosting service is
a processor, and it reaches personal data only through access the association's
administrator grants and its own audit log records (Beslutslogg 72). Every
principal in the product is a person (Beslutslogg 64; ADR 0009): a session, a
connected app's token and the action registry's caller all resolve to somebody
in the register, and no credential exists that is not somebody's. The host's
system is nobody in the register.

## Decision

### A listener of its own, off unless configured

The management API is a second HTTP listener in the same process, on
`OPENBRF_MANAGEMENT_PORT`, started after the application listens and closed on
shutdown with it. It is off unless that port and
`OPENBRF_MANAGEMENT_TOKEN_DIGEST` are both set; one without the other, or the
port equal to `PORT`, is a boot error naming the variable.

It answers `GET /v1/summary` and nothing else. Any other path, and any other
method on that one, is 404 `{ "reason": "not-found" }` before the token is looked
at, and no request body is parsed. The public address has no management path:
`/api/management/...` there is the JSON 404 every unknown API path gets, and
`/v1/summary` is the website's not-found page. The port is reachable only where
the host's network puts it - the container network on the same server, a private
network between servers - so a token that leaks is worth nothing from the
internet.

### A token the host holds and a digest the instance holds

The host mints the token, 32 random bytes as base64url, and keeps it. The
instance receives only its SHA-256 digest, base64url, the construction
`hashOpaqueToken` pins. Nothing in the instance's environment, database or
backups can be presented as the token, which is ADR 0009's reason for storing
an access token as a digest, applied to a machine credential. A digest rather
than an encrypted copy, because the instance never needs the value back; not in
the database, because a row would need a writer the host could reach.

The token arrives as `Authorization: Bearer <token>`, read from the raw headers:
two Authorization headers are refused rather than one of them believed. It is
digested and compared with every configured digest by `tokensMatch`, in
constant time. No match is 401 `{ "reason": "management-token-invalid" }`, and
which of missing, doubled, malformed or wrong it was is not said.

`OPENBRF_MANAGEMENT_TOKEN_DIGEST` takes one digest or two separated by a comma.
Rotation is: set the new digest beside the old one and restart; move the host
to the new token; drop the old digest at the next restart. A restart is the only
way the environment changes, and the two-digest window makes the order of the
two sides irrelevant.

### One versioned document of counts, a day and the version

The summary is one document, built in one transaction. Its fields, and where
each is read from:

- `schema`: 1.
- `version`, `revision`: the platform's version, from `apps/api/package.json`,
  and the commit the image was built from.
- `migrations.shipped`, `.applied`, `.failed`, `.pending`, `.latest`: the image's
  `prisma/migrations` folders, listed once at start, against `_prisma_migrations`
  (applied: finished and not rolled back; failed: neither).
- `claimed`: whether setup was completed.
- `apartments`: every apartment row. An apartment is deleted rather than
  retired, so the rows are the billing basis.
- `register.persons`, `.members`, `.residents`, `.boardSeats`,
  `.administrators`: every person; persons holding a member's residency today;
  persons holding any residency today; board seats held today; persons holding
  `ADMIN`. Counted from the register's own tables, not through the counts a
  plugin or a resident is given, which leave out protected persons (and, for a
  plugin, restricted ones): a protected member is a member.
- `invitedResidents`: persons holding a residency today, holding no board seat
  today and no system role, with an account or an invitation neither accepted
  nor expired. Counted from accounts, because an accepted invitation does not
  outlive its account and an open one is replaced on every re-invite; an
  account exists only by setup or by an invitation (ADR 0005), and setup's
  administrator holds a role.
- `boardActivityOn`: the latest day on the association's calendar (ADR 0013) on
  which a person holding a board seat or `ADMIN` today renewed a session or is
  the actor of an audit entry through `WEB`, `MCP`, `AI`, `PLUGIN` or no
  recorded channel; null when none. Sessions are renewed at most daily and
  deleted on sign-out; the audit log is permanent but records writes and
  sensitive reads only. The later of the two answers "active in the last thirty
  days".
- `registerExtracts.memberRegister`, `.apartmentRegister`: how many times each
  extract was generated, through the same channels.
- `storage.storedFileBytes`, `.databaseBytes`: the stored files' sizes as
  uploaded, and `pg_database_size` of the instance's database.
- `health.database`, `.pluginFindings`: `"ok"` once the transaction committed,
  and how many findings the plugins screen shows.

No field names or counts one person, and none carries an identifier, a name, a
date of birth or an apartment number. The only fact in time is a calendar day,
not a timestamp and not whose.

The channels are named rather than derived by leaving some out, so a channel
added later counts for nothing until it is decided that it should. `SYSTEM` is
the instance's own clock and `MANAGEMENT` is this document being read: neither
keeps a trial alive.

`schema` stays 1 while fields are added. A field removed, or one whose meaning
changes, is a new document at `/v2/summary`, and `/v1` is answered until the
host has moved - the rule ADR 0008 set for action names.

### An audit entry per read

Every successful read writes `INSTANCE_SUMMARY_READ` on a channel of its own,
`MANAGEMENT`, with no actor, no target and the context `{ "schema": 1 }`, in the
same transaction as the document: a read that fails part way writes no entry,
and an entry that cannot be written returns no document. It reaches no data
subject access report, because it names nobody, and it is there so the
association's own log shows when its processor read what. A refused token
writes nothing.

### A budget per process

Ten reads a minute, charged after the token matched and keyed on which
configured digest it matched, `"0"` or `"1"`: keying on the presented value
would let anybody open counters (ADR 0009). Over budget is 429
`{ "reason": "rate-limited" }` with `Retry-After`. The budget is per process,
as every budget in the application is, and bounds the audit entries the reads
write; the host needs a handful a day.

### Not an action, and not an OAuth resource

The summary is not an action: the registry's caller is a person resolved on
every call (ADR 0008), and this caller is not one. The module is not global and
exports nothing, so no plugin can resolve its service and the plugin seal's
classification is unchanged. The main listener's guard never reads the
management digests - the token presented on `APP_URL` is an anonymous request -
and the discovery documents do not mention the listener. It is read-only by
construction: one `GET`, one transaction, and a service that calls nothing that
writes; the audit entry is the only row it writes.

## Consequences

The port must never be published. The compose file maps no port for it and the
documentation says so; a host that published it would put a token-guarded
summary on the internet, which is what the separate listener exists to avoid.
Reaching it across servers needs a private network, and nothing encrypts the
connection.

A count is not a person, but not every count is anonymous. On a board of one,
`boardActivityOn` says that one person was active on that day, which the host
already knows by other means - it is the board's own sign-ins that keep the
trial alive, and the host runs the instance they sign in to.

"Extracts printed" is extracts generated. Printing is the browser's, and the
entry is written each time an extract is served; the abuse signal's thresholds
are calibrated on that.

Stored bytes are plaintext sizes. The files on the volume are 17 bytes larger
per 64 KiB (ADR 0015), and plugins and themes there are not counted.

The token lives in the host's environment of the instance, which is the host's
in any case. Whoever can set that environment can also replace the image.

The document is a contract with the host. Removing a field, or changing what
one means, is a new document version and, after 1.0, a major release.

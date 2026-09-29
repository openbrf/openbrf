# ADR 0023: Claiming a fresh instance

Date: 2026-09-27

## Status

Accepted

Narrows the first of the three ways an account comes to exist in
[ADR 0005](0005-authentication-and-account-model.md).

## Context

ADR 0005 lets the setup wizard create the first administrator while the
instance is unclaimed: no account exists and setup has never been completed.
`POST /api/setup/administrator` is the one write an anonymous caller can make,
and whoever makes it first becomes the administrator of an instance that will
hold a statutory register of personal data.

That was safe only while nobody but the operator could reach a fresh instance,
and nothing makes it so. A hosted instance is reachable at a known name the
moment it exists, and its certificate is published in the certificate
transparency logs before anybody has opened it, so a name can be found by
watching those logs. A self-hosted instance started behind TLS and left for an
hour is exposed the same way. `GET /api/setup/state` answers whether an
instance is unclaimed to anybody who asks, as it must, since the client needs
it to decide what to show.

## Decision

### One token, required on the one public write

`POST /api/setup/administrator` takes a `claimToken`, and creates nothing
unless it matches. The token is 32 random bytes, base64url, and what is held to
compare it against is its SHA-256 digest (`hashOpaqueToken`), compared in
constant time (`tokensMatch`).

The token reaches the instance's side in one of two ways.

**A digest from the environment.** A host that provisions instances mints the
token, sets `OPENBRF_SETUP_TOKEN_DIGEST` to its digest, and hands the board the
link. The instance never holds the token itself, so nothing in its environment,
its database or a backup of either can be presented as it.

**A token minted at start and printed to the log.** With no digest configured,
an unclaimed instance draws a token once its server listens, keeps the digest in
memory, and writes one line to its log:

```
This instance is unclaimed. Open <APP_URL>/app/setup#claim=<token> to create
the first administrator. The link works until the instance is claimed or
restarted.
```

Only the process that serves the wizard mints: the call is made after `listen`
in `main.ts`, and the CLI has an entry of its own. A restart draws a new token
and ends the old one. Once the instance is claimed nothing is printed, and a
configured digest is never printed: that start logs only that the instance
waits for its setup link.

In memory rather than in the database or on the data volume: there is nothing to
migrate, nothing in a backup, and restarting is how an operator ends a link that
leaked.

### The token travels in the fragment

The link is `/app/setup#claim=<token>`. A browser never sends a fragment to a
server, so the token reaches no proxy's access log and no `Referer`. The wizard
reads it, removes it from the address bar, holds it in the tab's session storage
until the claim (so a reload between the link and the form keeps it), and sends
it in the request body. Opened without the link, the wizard asks for the setup
code, which is the same token typed in.

### The order of the checks

The unclaimed check comes first and is unchanged: a claimed instance answers 409
`already-claimed` whatever the token, and says nothing the state endpoint does
not already say. The token is checked second, before anything is encrypted or
written, and a refusal is 403 `claim-token-invalid`. The token is optional in
the request schema, so a missing one is refused with that reason rather than
with the schema's `invalid-body`, which the wizard can only show as a weak
password.

A request that reaches the route before the instance has minted is refused: with
no digest configured and nothing minted yet, no token matches.

### What is recorded

A refused claim writes no audit entry. There is no association yet and nobody
to write it against, and the rate limit on the route - ten a minute per client
address - bounds the attempts; a 256-bit token needs no budget of its own. The
successful claim's `SYSTEM_ROLE_GRANTED` entry records `claimedWith`,
`environment` or `log`: where the token came from, never the token or its
digest.

## Consequences

The token is a credential in a log. ADR 0007 treats an application log as
collected and kept on the operator's schedule, and copied wherever the operator
ships it; a self-hoster who ships container logs to a third party ships an
unclaimed instance's link with them. What the link opens is an instance that
holds no data yet, and only until the claim or the next restart, whichever
comes first. The log line says so.

A restart before the claim invalidates the link, whatever restarted the
container. The operator reads the newest line; the wizard's refusal says to use
the newest link.

The setup state stays one boolean. The token narrows who may take the first of
ADR 0005's three paths; it adds no path and removes none, and recovering a lost
sole administrator stays an operator task at the database.

An operator reads the log once, with the same command that shows the instance
starting. A host delivers the link however it delivers anything else to the
board; how is outside this record.

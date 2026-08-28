---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Make the platform deployable, and test it the way it deploys.

A multi-stage image builds the web client and the API and serves both from one
container, so the session cookie the browser holds belongs to the same origin as
the API that issued it. `docker-compose.prod.yml` puts a PostgreSQL beside it
with named volumes, health checks on both and a slot for the catalog token.

The entrypoint does everything a deploy needs before the application listens: it
assembles both database connection URLs from their parts, so a password holding
`:`, `/`, `@`, `?` or `#` is percent-encoded rather than pointing the instance
at something else; it provisions the field encryption key on a genuine first
boot and refuses to invent one on any later boot; it applies migrations,
installs the job queue schema, and creates the constrained database role the
application connects as - so the application never owns the tables whose
triggers keep the member register and the audit log append-only. The owner's
credentials go no further than those steps: neither password is ever a process
argument, and both are dropped from the environment before the server starts,
so the process that serves requests holds the constrained connection alone. All
of it is idempotent, so an upgrade is a newer image - `docker compose -f
docker-compose.prod.yml --env-file .env.production build` while none is
published - followed by the same `up -d` that started the instance.

That role holds `CREATE` on the job queue's own schema and nowhere else, so a
feature - or an installed plugin - can declare a background queue while the
application is running, without a deploy step and without reaching the schema
the statutory registers live in.

Signing in with a passkey is now something the interface offers, not only
something the API supports. It asks for no email address, because the credential
is discoverable, and for no one-time code, because a passkey is
phishing-resistant.

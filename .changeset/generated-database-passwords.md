---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Run the production stack on a platform that gives every service every
variable, such as Coolify, by generating the database passwords instead of
asking for them.

`docker-compose.prod.yml` asks for no database password any more. A new
`superuser-password` service puts the database superuser's password in place
before the database starts, generating one on a first boot and on no other;
`schema-owner` generates the schema owner's, and `migrate` the runtime role's.
Each is kept on a volume that only the services using it mount, so the
application's container never holds the superuser's or the owner's password,
whatever a platform hands it. On Coolify 0.1.0 crash-looped on exactly that:
every variable reached the application, which refused to start holding them.

An instance that sets `POSTGRES_PASSWORD`, `OWNER_DB_PASSWORD` and
`RUNTIME_DB_PASSWORD` keeps working unchanged: a variable that is set wins, and
the first `up` writes `POSTGRES_PASSWORD` onto the superuser's volume, after
which all three can be emptied. docs/deployment.md, "The database passwords",
covers this, a lost superuser password, and "On a platform that shares every
variable" what to set there.

**Act on this when upgrading:** the application no longer publishes a port on
the host. A reverse proxy on the stack's network reaches it as `app:3000`; one
on the host itself adds the new release asset `docker-compose.host-port.yml` to
every `up`, which publishes it at `APP_BIND_ADDRESS` and `APP_PORT` as before.

A `BETTER_AUTH_SECRET` with whitespace in it is refused at start in
production. That includes the compose file's own message for a missing value,
which Coolify fills the variable in with and which the earlier checks let
through.

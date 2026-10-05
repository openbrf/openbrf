---
"@openbrf/api": minor
---

Harden how an instance is deployed and which database roles it uses.

The deploy steps - the field encryption key on a first boot, migrations, the
job queue schema and the application's own database role - now run in a
`migrate` service of their own, which exits once they have run; the
application starts only after it succeeded. The application's container is no
longer given the schema owner's or the superuser's credentials at all, and
refuses to start if it is. All of the instance's containers run with a
read-only root filesystem, no capabilities and `no-new-privileges`, and the
code in the image is owned by root, so the user they run as can write to
`/data` and a scratch `/tmp`, and nowhere else.

Migrations now run as `openbrf_owner` (or the name `OWNER_DB_USER` gives), a
schema owner that is not a superuser. A `schema-owner` service creates it as
the superuser on every `up`, before the migrate service, and on an instance
installed before it existed moves the superuser's tables to it; anything
another role owns in the application's schemas it names and leaves for the
operator to look at. An existing instance first replaces its
`docker-compose.prod.yml` with the release's, and fetches the release's
`env.production.example` to compare, since the new image does not start under
the old file; then it sets the new, required `OWNER_DB_PASSWORD`, and upgrades
with `pull` and `up -d` (`docs/deployment.md`, "Upgrading to a separate schema
owner"). An instance on a database server of its own
has its owner created by that server's administrator, and runs the migrate
service and then the application (`docs/deployment.md`). One that already ran
on such a server moves `POSTGRES_USER` and `POSTGRES_PASSWORD` to
`OWNER_DB_USER` and `OWNER_DB_PASSWORD` with the same values, does not run the
`schema-owner` service, and runs `run --rm --no-deps migrate` before
`up -d --no-deps app` (`docs/deployment.md`, "An instance on a shared database
server"). The `schema-owner` service refuses to run as a role that is not a
superuser, and names that section. An operator who
manages the runtime role themselves (`DATABASE_URL_RUNTIME`) constrains it
once, as `docs/deployment.md`, "Upgrading to a separate schema owner",
describes, since the start check below refuses a role that an earlier release
let write the migration history.

The application's role can no longer write the migration history or the job
schema's version, and no longer holds `CREATE` on the job schema, which no
queue needed. And in production the application now asks the database, before
it starts anything, whether the role it connected as is a constrained one, and
refuses to serve as a superuser, a role that owns anything in the
application's schemas, a member of another role, a role that can create objects
in those schemas, or one holding any privilege the hardening takes
away on the statutory archive, the migration history or the job schema's
version.

---
"@openbrf/api": minor
---

Harden how an instance is deployed and which database roles it uses.

The deploy steps - the field encryption key on a first boot, migrations, the
job queue schema and the application's own database role - now run in a
`migrate` service of their own, which exits once they have run; the
application starts only after it succeeded. The application's container is no
longer given the schema owner's credentials at all, and refuses to start if it
is. It runs with a read-only root filesystem, no capabilities and
`no-new-privileges`, and the code in the image is owned by root, so the user
the application runs as can write to `/data` and a scratch `/tmp`, and nowhere
else.

Migrations now run as `openbrf_owner`, a schema owner that is not a superuser;
the superuser's password stays in the database container. A new
`OWNER_DB_PASSWORD` setting is required. An existing instance creates the new
role once with the steps in `docs/deployment.md`, "Upgrading to a separate
schema owner", and deploys as before from then on. An operator who manages
the runtime role themselves (`DATABASE_URL_RUNTIME`) constrains it once in the
same section, since the start check below refuses a role that an earlier
release let write the migration history.

The application's role can no longer write the migration history or the job
schema's version, and no longer holds `CREATE` on the job schema, which no
queue needed. And in production the application now asks the database, before
it starts anything, whether the role it connected as is a constrained one, and
refuses to serve as a superuser, an owner, or a role that can rewrite the
member register, the audit log or the migration history.

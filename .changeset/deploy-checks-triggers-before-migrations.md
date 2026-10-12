---
"@openbrf/api": patch
---

Check the triggers themselves before the migrations run, not only who holds
TRIGGER.

A role holding TRIGGER on a table can replace a trigger on it with one that
does nothing, or add one of its own, without owning the table. The job schema
install looked only for that grant, and the hardening script, like the manual
`REVOKE` in `docs/deployment.md`, takes the grant away without a word, so a
guard replaced before an upgrade went unnoticed. The install also looked after
the owner's Prisma migrations had run, and a trigger planted by another role
fires with the privileges of whoever writes its table, the owner during the
migrations among them.

- `scripts/check-triggers.mjs` compares every trigger on a table in `public`
  and `pgboss` with the ones the migrations and the job schema install create,
  word for word, and checks that the table's owner owns the function each one
  calls. It also refuses a TRIGGER grant to a role other than a table's owner,
  or to `PUBLIC`, on those tables or in the owner's default privileges.
- The `migrate` service runs it before `prisma migrate deploy`, and the job
  schema install runs the same checks in place of its grant scan.

**Upgrade note:** a deployment that runs only the bundled steps sees no change.
One whose triggers were changed by hand, or that has a trigger of its own on an
Open BRF table, stops before the migrations with the trigger's definition in
the log. Put back the trigger the migration under `apps/api/prisma/migrations`
creates, or drop one you do not recognise, as the schema owner, and deploy
again.

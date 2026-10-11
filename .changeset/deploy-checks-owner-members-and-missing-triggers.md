---
"@openbrf/api": minor
---

Refuse, before the migrations run, a guard trigger that is missing, switched
off or calls a rewritten function, a role that can act as the schema owner,
and another role's ownership of or CREATE on the database.

The trigger check compared the triggers that are there with the ones Open BRF
creates, and looked for other roles' functions, grants and schemas. What the
schema owner can do itself left nothing for it to find: dropping a guard,
switching one off, or rewriting the function it calls with
`CREATE OR REPLACE FUNCTION`, which keeps the function's owner and every
trigger that calls it. A role that is a member of the owner can do all of
that as the owner.

- `scripts/check-triggers.mjs` now stops on a trigger that a migration which
  has run created and that is gone, and on one that does not fire as it was
  created (disabled, or made a replica or an always trigger). The trigger on
  `pgboss.queue` is not looked for: the job schema install puts it back on
  every deploy.
- It stops on a function a guard trigger calls whose language, settings,
  `SECURITY DEFINER` or body are not those the latest migration that has run
  gave it, an earlier migration's form included, and on a
  `public._prisma_migrations` that is not a table the schema owner owns.
- It stops while a role other than a superuser is a member of the schema
  owner, directly or through another role, and inherits its privileges or can
  `SET ROLE` to it. A role holding only `ADMIN OPTION` on the owner, as one
  that created it without being a superuser does, is not refused.
- It stops while the database belongs to a role other than the schema owner
  itself, and while a role other than the owner, or `PUBLIC`, holds `CREATE`
  on the database. Step 6 accepted a database owned by a role the owner is a
  member of.
- A schema named after the schema owner, which `"$user"` puts before `public`
  on the owner's search path, is checked as `public` is: its owner, `CREATE`
  on it, and the functions and operators in it.
- Every catalog query pins `search_path` to `pg_catalog, pg_temp`, and the job
  schema install's connections do the same, so pg-boss's SQL looks up names in
  the built-in catalog alone.

**Upgrade note:** a deployment that runs only the bundled steps sees no change.
An instance on a shared server may now stop before the migrations:

- `The database ... belongs to ..., not the schema owner.`: as a superuser,
  `ALTER DATABASE <database> OWNER TO <schema owner>`. A database owned by a
  group role the owner is a member of stops here too.
- `... holds CREATE on the database ...`: as the role that granted it,
  `REVOKE CREATE ON DATABASE <database> FROM <role>`, then look at the schemas
  and extensions that role created (`\dn` and `\dx` in psql).
- `... can act as the schema owner ...`: find out who granted the membership
  and what the role did, then `REVOKE <schema owner> FROM <role>` as a
  superuser or as the role that granted it. An administrator that created the
  owner and should keep administering it keeps only `ADMIN OPTION`:
  `REVOKE INHERIT OPTION FOR <schema owner> FROM <role>` and
  `REVOKE SET OPTION FOR <schema owner> FROM <role>`.
- `... is missing the trigger ...`, `... does not fire as it was created ...`
  or `... calling a function that is not as the migrations ... wrote it ...`:
  someone changed a guard with the schema owner's privileges. Find out who
  and what was written while it was off, then put the trigger or function
  back from the migration under `prisma/migrations` that wrote it.

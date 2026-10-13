---
"@openbrf/api": minor
---

Refuse, before the migrations run, a guard trigger that is missing, switched
off or calls a rewritten function, a role that is a member of the schema
owner, a setting stored for the owner or the database that is not known to be
harmless, and another role's ownership of or CREATE on the database.

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
  gave it, an earlier migration's form included.
- It stops on a `public._prisma_migrations` that is not a table the schema
  owner owns, that forces row-level security, under which a policy could
  hide the migrations that created a guard, or that has a parent or a child
  table, into which a migration's row could be moved where Prisma still
  counts it as applied. It reads that table with `row_security` off, so that
  a policy fails the read rather than running.
- It stops while a role other than a superuser is a member of the schema
  owner, directly or through another role. That includes a role holding only
  `ADMIN OPTION`, as one that created the owner without being a superuser does
  on PostgreSQL 16 and later: it can grant itself the owner's privileges at
  any time. A member with none of these options is refused too: a role
  holding `ADMIN OPTION` can let it act as the owner. `docs/deployment.md`
  shows how an administrator without a superuser, as on a managed server,
  creates an owner no role is left a member of.
- It stops on a setting stored for the schema owner (`ALTER ROLE ... SET`, in
  every database or in this one) or for the database (`ALTER DATABASE ...
SET`): each applies to the migrations' sessions. Settings of memory, time
  limits and planner costs, `TimeZone` and `application_name` pass; any other
  is refused, `search_path`, `session_replication_role` and
  `transform_null_equals` among them, so that one nobody has looked at yet
  stops the deploy rather than slipping past it.
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
- The message a passing check prints says how many guard triggers it looked
  for, that the one on `pgboss.queue` is left to the job schema install, and
  that a superuser can still act as the owner.

The check sees the database as it is at deploy time. A guard switched off and
back on between two deploys, by someone holding the owner's password, leaves
nothing for it to find. `docs/deployment.md` says how to log that with
`log_statement = 'ddl'` or `pgaudit`.

**Upgrade note:** a deployment that runs only the bundled steps sees no change.
An instance on a shared server may now stop before the migrations:

- `The database ... belongs to ..., not the schema owner.`: as a superuser,
  `ALTER DATABASE <database> OWNER TO <schema owner>`. A database owned by a
  group role the owner is a member of stops here too.
- `... holds CREATE on the database ...`: as the role that granted it,
  `REVOKE CREATE ON DATABASE <database> FROM <role>`, then look at the schemas
  and extensions that role created (`\dn` and `\dx` in psql).
- `... can act as the schema owner ...` or `... is a member of the schema
owner ...`: find out who granted the membership and what the role did, then
  `REVOKE <schema owner> FROM <role>` as a superuser or as the role that
  granted it. An administrator that created the owner without being a
  superuser holds `ADMIN OPTION` on it, which only a superuser can revoke.
  Where nobody holds one, as on a managed server, move the instance to an
  owner created by a role that is dropped afterwards, as
  `docs/deployment.md` ("Several instances on one database server") shows.
- `... has the stored setting ...`: as the schema owner,
  `ALTER ROLE <schema owner> RESET <setting>`, with `IN DATABASE <database>`
  where the message names the owner in the database, or
  `ALTER DATABASE <database> RESET <setting>`.
- `public._prisma_migrations ... forces row-level security ...`: find out who
  turned it on and whether rows were taken out, then, as the schema owner,
  drop its policies and run `ALTER TABLE public._prisma_migrations
NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY`.
- `public._prisma_migrations ... takes part in table inheritance ...`: find
  out who did it and which rows were moved, then, as the schema owner, copy
  the migrations' rows in a child back into `public._prisma_migrations` and
  run `ALTER TABLE <child> NO INHERIT public._prisma_migrations`, or
  `ALTER TABLE public._prisma_migrations NO INHERIT <parent>`.
- `... is missing the trigger ...`, `... does not fire as it was created ...`
  or `... calling a function that is not as the migrations ... wrote it ...`:
  someone changed a guard with the schema owner's privileges. Find out who
  and what was written while it was off, then put the trigger or function
  back from the migration under `prisma/migrations` that wrote it.

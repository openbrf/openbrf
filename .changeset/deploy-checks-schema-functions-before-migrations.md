---
"@openbrf/api": patch
---

Refuse functions and operators of other roles in the application's schemas,
and other roles' CREATE on them, before the migrations run.

A name a migration or pg-boss calls without a schema can resolve to a function
or operator in `public` or `pgboss`. PostgreSQL takes the best match for the
arguments from every schema on the search path, so one there can win over the
built-in, and it runs as the caller: the schema owner during the migrations
among them. A database restored from a dump made before PostgreSQL 15 lets
every role create one in `public`, and the hardening revokes that only after
the migrations have run.

- `scripts/check-triggers.mjs` now also stops on a function, procedure,
  aggregate or operator in `public` or `pgboss` that a role other than the
  schema owner owns, and while another role, or `PUBLIC`, holds `CREATE` on
  either schema or is given it by the owner's default privileges.
- Every catalog query the check runs pins `search_path` to `pg_catalog`. Only
  the first one did, so the others could call a function in `public` that
  matched their arguments better than the built-in, as the owner.

**Upgrade note:** a deployment that runs only the bundled steps sees no change.
One whose database was restored from a dump made before PostgreSQL 15 may still
give `PUBLIC` `CREATE` on `public`, and now stops before the migrations with
`PUBLIC holds CREATE in public.` in the log. Run
`REVOKE CREATE ON SCHEMA public FROM PUBLIC` as the schema owner, look at any
function or operator the log names, and deploy again.

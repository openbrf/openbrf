---
"@openbrf/api": patch
---

Take TRIGGER, REFERENCES and TRUNCATE away from the application's database
role on every table in `public` and `pgboss`, and refuse to go on while a role
other than the owner holds TRIGGER there.

`CREATE OR REPLACE TRIGGER` asks for the TRIGGER privilege on a table, not for
its ownership. The hardening script never granted it, but it did not revoke it
either, so a grant made outside it - by an earlier tool, or a `GRANT ALL` by
hand - let the application's role replace the triggers that keep the statutory
archive append-only, and the one that guards `pgboss.queue`, with triggers that
do nothing.

- `harden-runtime-role.sql` now revokes the three privileges from the runtime
  role and from `PUBLIC` on every table in both schemas, and in the default
  privileges for tables created later. It then checks that none is left, and
  stops if a grant another role made has survived the owner's revoke.
- The job schema install stops while any role other than a table's owner, or
  `PUBLIC`, holds TRIGGER on a table in either schema. It does not revoke the
  grant itself, because a role that held it may already have replaced a
  trigger, and a person has to check that.
- A production start refuses an application role that holds TRIGGER on any of
  those tables.

Nothing Open BRF grants holds these privileges, so a deployment that runs only
the bundled steps sees no change.

---
"@openbrf/api": minor
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
  `PUBLIC`, holds TRIGGER on a table in either schema. It looks before pg-boss
  migrates and again after, so a table pg-boss has just created, which takes
  its grants from the owner's default privileges, is checked too. It does not
  revoke the grant itself, because a role that held it may already have
  replaced a trigger, and a person has to check that.
- A production start refuses an application role that holds TRIGGER on any of
  those tables.

**Upgrade note:** nothing Open BRF grants holds these privileges, so a
deployment that runs only the bundled steps needs nothing. One where TRIGGER
was granted by hand or by another tool stops at the job schema install, or at
the application's start, until the grant is gone. Before upgrading, as the
schema owner:

1. List who holds TRIGGER on a table they do not own:

   ```sql
   SELECT n.nspname, c.relname,
          CASE WHEN g.grantee = 0 THEN 'PUBLIC'
               ELSE pg_get_userbyid(g.grantee) END AS grantee
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) AS g
   WHERE n.nspname IN ('public', 'pgboss')
     AND g.grantee <> c.relowner
     AND g.privilege_type = 'TRIGGER';
   ```

   and the default privileges that would grant it to tables created later,
   with `\ddp` in psql.

2. If any row comes back, check that the triggers on those tables are still
   the ones the migrations and the job schema install created, since whoever
   held TRIGGER could have replaced one:

   ```sql
   SELECT tgrelid::regclass, tgname, pg_get_triggerdef(oid)
   FROM pg_trigger
   WHERE NOT tgisinternal;
   ```

3. Then, as the role that granted it, revoke it from each role listed, and
   from each default privilege that grants it, adding `FOR ROLE` and
   `IN SCHEMA` as `\ddp` shows them:

   ```sql
   REVOKE TRIGGER ON ALL TABLES IN SCHEMA public, pgboss FROM some_role;
   ALTER DEFAULT PRIVILEGES REVOKE TRIGGER ON TABLES FROM some_role;
   ```

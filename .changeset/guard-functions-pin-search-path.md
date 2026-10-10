---
"@openbrf/api": minor
---

Stop a temporary table from standing in for a table a statutory guard reads,
and take temporary tables away from the application's database role.

The triggers that check a transfer reversal and a reporting obligation against
their transfer read `transfer` by an unqualified name. A trigger function runs
as whoever writes the table and resolves such a name through that session's
`search_path`, where the session's temporary schema comes first. The
application's role could create temporary tables, so it could create a
`transfer` of its own and record a reversal of a grant, or a reporting
obligation the association does not have, on tables that cannot be corrected
afterwards.

- A migration sets `search_path = pg_catalog, pg_temp` on every `openbrf_`
  function and names each table and type the two guards read with its schema.
  The triggers themselves are unchanged.
- `harden-runtime-role.sql` revokes `TEMPORARY` on the database from the
  runtime role and from `PUBLIC`, and stops if a grant made by another role
  survives the revoke.

**Upgrade note:** a deployment that runs the bundled steps needs nothing. One
that manages its runtime role by hand runs, as the database's owner,
`REVOKE TEMPORARY ON DATABASE <database> FROM <runtime role>, PUBLIC`. A
monitoring or backup role that creates temporary tables is then granted
`TEMPORARY` by the owner.

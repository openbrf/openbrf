---
"@openbrf/api": minor
---

Refuse to start when the application's database role can still create
temporary tables.

A temporary table hides a table of the same name for the session that made
it. The guard functions no longer read through the session's `search_path`,
and the bundled deploy steps revoke `TEMPORARY` from the runtime role, but a
deployment that manages its runtime role by hand only loses it when its owner
runs the revoke. The startup check now asks the database whether the role
holds `TEMPORARY`, and refuses with the `REVOKE` statement to run when it does.

**Upgrade note:** a deployment that runs the bundled steps needs nothing. One
that manages its runtime role by hand and has not run the revoke from the
previous release's note does so before this upgrade's `up -d`, as the
database's owner:
`REVOKE TEMPORARY ON DATABASE <database> FROM <runtime role>, PUBLIC`. Then
check that
`SELECT has_database_privilege('<runtime role>', current_database(), 'TEMPORARY')`
answers `f`: a grant made by another role survives that revoke with only a
warning, and has to be revoked by the role that made it.

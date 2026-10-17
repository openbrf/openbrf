---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Keep the schema owner's and the runtime role's passwords out of the database's
log. The deploy steps used to send each password inside the `ALTER ROLE`
statement that sets it. PostgreSQL logs a failed statement in full, and logs
every statement on a server set to `log_statement = ddl`, so the password could
end up in the `db` container's log. The steps now work out the password's
SCRAM-SHA-256 verifier themselves, as psql's `\password` does, and send that
instead. PostgreSQL stores a verifier as it is given, so signing in does not
change. A password that SASLprep would change, such as one with a ligature or a
non-breaking space, is still sent as it is.

docs/deployment.md, "On a platform that shares every variable", now has an
instance that set its passwords as variables give its superuser a new password.
Until now it kept the old one, which the platform had handed to every service.
The docs no longer have it keep `POSTGRES_PASSWORD` for one deploy either: on
such a platform both the database and the application refuse that variable.

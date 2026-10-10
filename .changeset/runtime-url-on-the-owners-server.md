---
"@openbrf/api": patch
---

The `migrate` service now refuses a `DATABASE_URL` that names another server or
database than `POSTGRES_HOST`, `POSTGRES_PORT` and `POSTGRES_DB`, unless
`DATABASE_URL_RUNTIME` is set. The application builds its own connection from
those three, so the runtime role was constrained on one server while the
application connected to another.

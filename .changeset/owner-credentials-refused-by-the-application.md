---
"@openbrf/api": patch
---

The application itself now refuses a production start with `OWNER_DB_PASSWORD`,
`POSTGRES_PASSWORD`, or a `DATABASE_URL` beside the runtime connection in its
environment, as the image's entrypoint already did. A platform that starts the
server without that entrypoint is held to the same rule.

---
"@openbrf/api": minor
---

Publish the platform as a container image. Every release is built for amd64 and
arm64, tagged with its exact version and its minor line, and carries a build
provenance attestation naming the commit and the workflow that built it. The
production Compose file runs the published image at the release line an
operator chooses, and an upgrade is a pull and a restart.

An instance names its version when it starts. Several instances can share one
PostgreSQL server: each names its own application role, each database is closed
to every other role on the server, the size of the connection pool is a
setting, and the application role may hold that pool, the job queue's and three
connections more. A start refuses a server where that isolation would not hold:
an owner that is not the database's, a non-superuser owner on PostgreSQL older
than 16, or an application role another database already grants. It also
refuses a `DATABASE_URL_RUNTIME` that signs in as another role than the one
`RUNTIME_DB_PASSWORD` has it constrain, one that signs in as the owner, and one
with a `user` query parameter.

Upgrading an existing instance: its first start closes the database to every
role but the owner and the application role. A separate backup or monitoring
role needs `GRANT CONNECT ON DATABASE <database> TO <role>` from the owner
(docs/backup-and-restore.md, "Before an upgrade").

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
to every other role on the server, and the size of the connection pool is a
setting.

---
"@openbrf/api": patch
---

Harden the job queue schema install that the `migrate` service runs as the
schema owner. The application's database role can no longer write pg-boss's
queue of index builds, only read it. Before installing, the install now stops
on a queue that is partitioned or names a job table of its own, which Open BRF
never declares. It also removes index builds that have not run yet while a role
other than the owner can still write that queue.

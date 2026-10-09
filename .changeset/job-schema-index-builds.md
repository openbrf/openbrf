---
"@openbrf/api": patch
---

Finish the job queue's index builds at deploy, and stop the deploy when one
fails.

A pg-boss upgrade that adds an index to job tables that already exist does not
build it during the migration: it records the build in `pgboss.bam` for a
background runner that only an instance with pg-boss migration enabled runs.
The application runs with migration disabled in production, and the job schema
installer stopped pg-boss straight after starting it, which left the runner
time for one build at most. So on an upgraded instance a build could stay
pending with nothing to finish it, and a failed one still let the deploy go
on. The installer now waits until every queued build has finished, and exits
non-zero when one fails, with the error kept in `pgboss.bam`. The next deploy
retries it, and also finishes any build an earlier deploy left behind. A fresh
install builds its indexes inline and does not wait.

---
"@openbrf/api": patch
---

When an index build fails, the job schema installer now waits for any index
build that is already running before it exits. pg-boss starts the next pending
build right after one fails. The installer used to stop without waiting, so the
database finished that build but its row in `pgboss.bam` stayed in progress,
and pg-boss started no other build until the row was five minutes old. The next
deploy therefore built nothing for at least five minutes and printed nothing
about why. When the installer finds a build that has been in progress since
before it started, it now says so and explains what it is waiting for.

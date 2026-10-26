---
"@openbrf/api": patch
---

When an index build fails, the job schema installer now waits, for up to ten
minutes, for any index build that is already running before it exits. pg-boss
starts the next pending build right after one fails. The installer used to stop
without waiting, so the database finished that build but it stayed marked as
running, and pg-boss started no other build until that mark was five minutes
old. The next deploy therefore built nothing for at least five minutes and
printed nothing about why. A build that takes longer than ten minutes is still
left marked as running when the installer exits. When the installer finds a
build that has been marked as running since before it started, it now says so
and explains what it is waiting for.

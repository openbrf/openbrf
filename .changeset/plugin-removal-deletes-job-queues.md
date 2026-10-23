---
"@openbrf/api": patch
---

Removing a plugin now deletes its job queues as well: the jobs waiting on them,
the finance events not yet handed to it, and its cron schedules. Before, they
stayed in the job schema, a schedule went on adding jobs that nothing worked,
and a plugin installed later under the same id was handed all of them. Where
the deletion fails, the next install under the id deletes them before it
writes anything, and that install also clears what removals made before this
release left behind. No deploy step is needed.

---
"@openbrf/api": patch
---

Removing a plugin now deletes its job queues as well: the jobs waiting on them,
the finance events not yet handed to it, its cron schedules, and their
occurrences not yet sent to it. Before, they stayed in the job schema, a
schedule went on adding jobs that nothing worked, and a plugin installed later
under the same id was handed all of them. Where the deletion fails, the next
install under the id deletes them before it writes anything, and refuses while
it cannot; that install also clears what removals made before this release left
behind. A cron occurrence the removed plugin's schedule was already sending
never reaches the next plugin's handler: a job a cron schedule sends is now
handed only to the queue that schedule was made for, not to a queue made again
under the same name, from the first time the schedule is made on this release.
No deploy step is needed.

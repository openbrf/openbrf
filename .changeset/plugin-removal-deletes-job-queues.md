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
under the same name. That holds for a schedule an earlier release made as well:
each start gives such a schedule the queue it belongs to before its first cron
pass. No deploy step is needed beyond the usual order of stopping the old
release before the new one starts: a host still on an earlier release would
hand its handlers a cron schedule's data together with the queue it was made
for, rather than the data alone.

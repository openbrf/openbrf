---
"@openbrf/api": patch
---

Make the job queue's table refuse a partitioned queue, or one with a job table
of its own, for every role but the schema owner.

The job schema installer already stops when `pgboss.queue` holds such a row,
because pg-boss builds SQL from its table name when it migrates the schema as
the owner. That check ran once, before the migration, so a role that can write
`pgboss.queue` - the application's, which declares queues at runtime - could
add one in the gap while a migration was pending. The installer now also puts a
trigger on the table, owned by the schema owner, that rejects an insert or an
update that sets `partition` or a `table_name` other than `job_common`. The
application's ordinary queues are unaffected, and the application's role can
neither disable nor drop the trigger.

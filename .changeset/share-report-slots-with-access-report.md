---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Gather the board's data subject access report in the same slots as a member's
export of their own data.

`POST /api/data-subject-reports/persons/:personId` runs the same long report
transaction as `POST /api/data-portability/mine`, and so holds a pooled
database connection for as long as it runs, but it had no limit: a few reports
asked for at once could still hold the pool. The cap of three reports gathered
at once now belongs to the report service, which both routes go through, so
the board's reports and the members' exports share one set of three slots. A
request that finds all three taken, on either route, is answered 429
`export-busy` with a `Retry-After` header before anything is read, and writes
no audit entry.

The member's per-person and instance budgets stay where they were. An export
the report service turns away as busy is charged to neither, as before. The
board's route has no per-person budget: it is held by the board and an
administrator, and the slots are what bound the connections.

The access report screen says when the instance is busy, in Swedish and
English, instead of the general failure, and offers to try again.

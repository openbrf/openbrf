---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Rate-limit the export of a person's own data (`POST /api/data-portability/mine`).

Gathering the report holds a database connection for as long as its transaction
runs, which can be up to 30 seconds, so a few members exporting at once could
hold the default pool of ten and starve the rest of the API. Each member now has
three exports a minute, and the instance twelve a minute in all, which at the
longest transaction is six connections at the very worst. A request over either
budget is answered 429 with a `Retry-After` header before anything is gathered,
and writes no audit entry. A member who is refused takes nothing from the
instance's budget, so one person pressing the button in a loop cannot use up
what everybody else exports from.

The two refusals have their own reasons, `export-rate-limited` and
`export-busy`, because the person can act on only the first. The download on the
profile page shows a sentence for each, in Swedish and English, instead of the
general failure.

The counters are in memory and per process, like the limiter on the public
forms; the instance is one process, so that is the instance's whole count.

---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Rate-limit the export of a person's own data (`POST /api/data-portability/mine`).

Gathering the report holds a database connection for as long as its transaction
runs, so a few people exporting at once could hold the default pool of ten and
starve the rest of the API. Each person now has three exports a minute, the
instance twelve a minute in all, and no more than three are prepared at once,
which is the most connections exports can hold however long their transaction
takes. A request over a budget, or one that finds all three under way, is
answered 429 with a `Retry-After` header before anything is gathered, and writes
no audit entry. A person who is refused takes nothing from the instance's
budget, so one person pressing the button in a loop cannot use up what
everybody else exports from. A request refused as busy takes nothing from the
person's own budget either.

The two refusals have their own reasons, `export-rate-limited` and
`export-busy`, because the person can act on only the first. The download on the
profile page shows a sentence for each, in Swedish and English, instead of the
general failure.

The counters are in memory and per process, like the limiter on the public
forms; the instance is one process, so that is the instance's whole count. An
instance run as more than one application container multiplies every one of
these limits by the number of containers.

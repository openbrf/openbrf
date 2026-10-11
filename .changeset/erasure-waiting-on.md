---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Show the board what a granted erasure request is waiting on.

A granted erasure request the purge left open said why only in the run's log
line and its audit entry. The person's page showed "granted" and nothing else,
so a board could not see that a legal hold, an open motion or key order, or a
consented letting that still runs was holding it, or that recording the
letting's end would let it go.

The board's person view (`GET /api/address-book/persons/:id`) now carries
`erasureWaitingOn` for the granted, unexecuted erasure: the status (`blocked`
or `incomplete`), the rule that refuses the purge if one does, each domain
still holding rows with its owed and kept counts, and `lettingLastDay`, the
last day of a consented letting that keeps a subletting application (the
recorded end where there is one, otherwise the period's). The request's row
says the same in the board's language. It is computed on every read and never
stored. Like the log line, it carries counts and a rule, never a row.

The purge's run account and the screen now read an open request through one
function, so they cannot disagree about why it is open. The log line keeps
its words.

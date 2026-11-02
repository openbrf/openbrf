---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Issue types and statuses are the board's own data (ADR 0054).

An issue type is one row with the groups who may report it - any of the
website's form, signed-in residents and handlers alone - where it used to be
offered to one audience. Upgrading merges types with the same name into one
offered to all of their audiences, as long as they agree on being switched on:
the switched-on ones of a name merge into one type and the switched-off ones
into another, so an audience the board had closed stays closed.

Every type has its own statuses, each belonging to one of four fixed meanings:
new, in progress, waiting and done. A type starts with one status of each
meaning, and the board can rename them, add its own, switch one off and
choose which status of a meaning an issue enters by default. Moving an issue
into a waiting status asks whom it waits on (the reporter, a contractor, parts
or a decision), and closing one asks how it ended (fixed, the tenant-owner's
responsibility, no fault or referred). Upgrading moves every issue onto the
default status of its old status's meaning, keeps its closing date and its
history, and gives an issue closed earlier no outcome.

The queue is ordered by meaning, then by the board's order of the statuses
within a meaning and then oldest first, and the purge of a public report's
contact details, the reporter's own list, the badge on a post, the overview and
the data subject access report read the meaning and never the board's label. A new instance starts with a Swedish set
of issue types, so the website's form takes a report from the first day.

For connected apps and the AI package, `issue_list` and `issue_get` give the
status as its meaning and the board's label with the waiting reason and the
outcome, the type's reporter groups instead of its audience, and filter by
`meaning` and `reporter`; `issue_type_list` gives each type's statuses.

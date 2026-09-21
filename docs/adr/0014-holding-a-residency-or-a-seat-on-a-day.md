# ADR 0014: Holding a residency or a seat on a day

Date: 2026-09-21

## Status

Accepted

## Context

Two tables record who holds what for a period. A residency runs from
`movedInOn` to `movedOutOn`, and a board seat from `electedOn` to `endedOn`. All
four columns are `@db.Date`, and both periods are routinely recorded ahead of
time: a buyer is moved in before the day they take over the apartment, a
move-out is entered before it happens, an election is minuted before the term
begins, and a term is given the date of the next annual meeting. Neither the
move flow nor the board-position API refuses a date ahead of today, and neither
should.

Almost every question the product asks about the present is a question about
which of those periods are held on a day: the roles a principal is built from,
who is in a room, which apartments a person may book, order a key for, file an
issue against or apply to sublet, which members a news item is sent to, which
holders the initial supply to the cooperative housing register lists, who the
website prints as the board, and who the association's reminders reach.

Those questions were asked of the end of the period alone, against an instant:
`movedOutOn` null or later than `new Date()`. That counted a period whose first
day had not arrived, so a buyer recorded ahead of time was a resident and a
member from the moment the move was typed in, while the seller still lived
there. It also put the boundary at midnight UTC rather than at midnight here,
which is the defect ADR 0013 describes for every `@db.Date` column.

The readers also disagreed about what the end date means. Most read it as the
first day the period is no longer held. The attribution of apartment charges to
a data subject access report, the apartment on the debiting list, the holders
named on a fee notice and the move flow's check for an overlapping residency
read it as the last day held.

## Decision

### The start date is the first day held, and the end date the first day not

On both tables and at both ends. A household whose move-out date is the 30th
held the apartment on the 29th and not on the 30th, and a household moving in
on the 30th holds it from that day, so no day is held by two households and none
by nobody. A seat ending on the 30th confers nothing on the 30th.

This is the reading the voting register and the booking rule state, the one
every access check already applied, and the one the move-out notice gives the
person moving out: their access ends on that date. The member register writes
the move-out date as the exit, and a membership whose exit is dated today is not
current.

### Held on a day is decided on the association's calendar, as a date

`apps/api/src/registers/held-on.ts` holds the rule: `residencyHeldOn(day)` and
`boardSeatHeldOn(day)` for a query, and `isResidencyHeldOn(residency, day)` for
a row already read. The day is a `LocalDay` rather than a `Date`, so an instant
cannot be handed in; today is `localDayOf(now)`, and the day a date column holds
is `localDayOfColumn(value)`. It is ADR 0013's rule for a date column, applied
to a period.

It lives in the API because the API is the only application that asks it of the
database and every caller is an API module, and in `registers/` beside
`residency-lock.ts`, the other rule every reader and writer of the residency
table has to share. The calendar it is built on is `packages/shared`.

### Held and not yet ended are different questions

"Held on this day" asks for both ends. It is what access, membership, a room,
an own-apartment picker, a mailing, a plugin's list of residents, a register's
current holders, the published board and every list of recipients ask - and the
member register's current extract, the apartment on the debiting list, the
charges on a data subject access report and the holders on a fee notice, each
on its own day.

"Not yet ended" asks for the end alone, and counts a period that has not begun.
It is what keeps a person out of the purge and out of a granted erasure, because
somebody recorded as moving in next month has a relationship with the
association already. It is what decides whether a term's end date may still be
amended and whether a second election to the same position duplicates one, and
whether the board's screens show a residency as moved out. It is what matches a
row of an import to a person already on the apartment. `hasMovedOut` and
`hasTermEnded` answer it on the association's calendar: a move-out dated today
has happened, and a term ending today has ended.

## Consequences

A buyer recorded ahead of the day they take over holds nothing until that day:
no resident or member capabilities, no place in a room, no apartment to book
against, no news mailing, no line in the member register's current extract and
no apartment register entry of their own. The seller keeps all of it until the
move-out date. An election recorded ahead confers nothing until its day.

Access ends at midnight here on the move-out date or the end date, rather than
at midnight UTC an hour or two later.

A charge dated on a move-out date belongs to the household that moved in that
day. It is not on the report of the household that moved out, and the debiting
list names only the apartment moved into. A fee notice names the holders on the
last day of its period, so a seller whose move-out date is that day is not named
on it.

A person may be moved back into an apartment on the day an earlier residency of
theirs on it ended, which is how a resident becomes a joint holder without a day
held twice.

Two write-time decisions keep reading the end alone: whether a move-in begins a
membership and whether a move-out ends one. Each counts the person's other
tenant-ownerships that have not ended, including one recorded ahead of time,
because it decides what an append-only archive records at the moment of
writing; a gap between two recorded holdings is written as one continuous
membership.

The purge and the erasure refusal that mirrors it compare the end date against
an instant. The difference is a delay of up to two hours after midnight before a
person becomes erasable, on the protecting side.

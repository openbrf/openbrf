# ADR 0010: The association's calendar day

Date: 2026-09-18

## Status

Accepted

## Context

Open BRF is a platform for Swedish housing cooperatives. Every date it prints is
a date in the association's own zone - the day a register extract was taken, the
day a consent was withdrawn, the day a breach was discovered, the day a charge
belongs to. Europe/Stockholm is one or two hours ahead of UTC, so for one hour a
day under CET and two under CEST, the UTC day and the association's day are
different days.

No container in this repository sets `TZ`. Not the `Dockerfile`, not
`docker-compose.yml`, not the end-to-end stack's compose file. Everything runs
in UTC, where reading a date in UTC and reading it here agree for twenty-two or
twenty-three hours out of every twenty-four. That is why a whole class of defect
survived: every test written without a boundary-crossing instant passed against
broken code, and the broken code looked right in every manual check that was not
made late in the evening.

Two of the documents this reached are statutory register extracts - the member
register and the apartment register - and a third is the art. 15 report a person
is entitled to. A document produced at half past midnight on the 6th of March
stated the 5th.

Three kinds of value in this codebase are all a `Date`, and the right
arithmetic differs for each. Nothing in the type distinguishes them, so the
distinction has to be carried by the names at the call site.

## Decision

### Three kinds of date, and only one of them takes the association's zone

**A `@db.Date` column.** A calendar date with no time and no zone. Postgres
stores the date; the client reads it back as midnight UTC. Its UTC fields are
therefore the date it holds, and reading it in the association's zone asks a
question the column has no answer to - midnight UTC is a moment on the evening
before here for part of the year, so a residency beginning on a booked day would
compare as starting after the period it covers. `formatDateColumn` is the
rendering, and `localDayOfColumn` and `dateColumnOf` are the conversions.

**A duration.** A retention window, or the seventy-two hours of art. 33. This is
millisecond arithmetic on an instant, deliberately, because an hour is a real
amount of a three-day statutory deadline and a calendar has nothing to say about
it. Unchanged by this decision.

**An instant stated as a day.** What a person reads off a document or a screen.
The day an instant fell on is the day it fell on here, so this is
`formatDayOfInstant`, or the composition `formatLocalDay(localDayOf(instant))`
that eighteen call sites already spell out. This is the only one of the three
that was being done wrong.

Which kind a value is, is decided **against the schema and never against the
field name**. The convention that a field ending `On` is a column and one ending
`At` is an instant is not load-bearing and has exceptions on the wire: the
publication consents on the art. 15 report emit `grantedOn` and `withdrawnOn`
from `grantedAt` and `withdrawnAt`, which are plain `DateTime`.

### The calendar lives in `packages/shared`, and the zone is named once

The module moved out of the booking feature it was written in because both
applications need it: fourteen browser files turn an instant into a day. The
whole module moved rather than a slice of it, because a conversion with only one
direction is what somebody does the other way round by hand, and because
splitting it would leave two homes for one zone. `ASSOCIATION_TIME_ZONE` is
declared there and imported everywhere, with one exception that is a promise
rather than a copy: `apps/web/src/bookings/booking-calendar.ts` re-exports it,
because its own doc comment promises to be the one place in the client that
names a zone and four screens rely on that promise.

The end-to-end package keeps its own literals. A test that reads the same
constant as the code under test proves nothing.

### The helper is named for what it takes, not for what it returns

`formatDateColumn(value)` and `formatDayOfInstant(value)` are both
`Date -> string` and differ only in the arithmetic. The name is the only thing
that tells a reader which one a call site wants, which is why the precondition
is in the name: `formatDateColumn(now)` reads as a mistake where the eight
private slicers it replaced - `isoDate`, `toIsoDate`, `toCalendarDate`, each
some spelling of `iso.slice(0, iso.indexOf("T"))` - did not. Both carry a
nullable overload, because most of the documents are full of optional dates and
the alternative is a guard at every field.

In the browser, `localDayOfInstant(iso)` sits beside `localDayNow()` in the
module that names the zone. It takes an ISO string, which is what the API sends
and what the API itself never has to convert, and its implementation composes
the shared functions so a screen and a document cannot answer different days for
one moment.

### The purge windows keep millisecond arithmetic; the render carries the zone

Each `compute*PurgeDate` is paired with a `*PurgeCutoff` the nightly scan uses,
and the invariant stated in `member-charge-retention.ts` is that the two must
agree or the product erases on a day other than the one it stated. So the zone
is applied where an instant becomes a calendar claim - at the render - and not
in the computation. `computeMemberChargePurgeDate` is the exception that proves
it: it anchors on a financial year, which is genuinely a calendar fact, so it
returns a date-column value and its rendering stays `formatDateColumn`.

One consequence is stated here rather than left to be rediscovered: the reported
date and the scan can differ by a day at the edge. The report states the
association's day a purge instant falls on; the scan compares instants. A row
whose purge instant is 22:30 UTC is stated as erasable on the following day here
and is erased by the run that night. That is the honest reading of "the earliest
date the purge can reach the row", which is what the field says it is.

### A test for this class picks a boundary instant and never sets `TZ`

Setting `process.env["TZ"]` proves nothing about this: `Intl` with an explicit
`timeZone` ignores the process zone and `toISOString` is always UTC, so both
sides of the comparison are zone-independent already. What a test needs is an
instant whose UTC day and Stockholm day differ:

- `2026-06-21T22:30:00.000Z` is the 21st in UTC and the 22nd here (CEST).
- `2026-12-21T23:30:00.000Z` is the 21st in UTC and the 22nd here (CET).

`board-mailbox-retention.spec.ts` does set `TZ`, and correctly: that module does
calendar-field arithmetic in local time, which is a different question.

## Consequences

Seventeen screens and two statutory extracts state a different date than they
did, for the hour or two a day the two readings disagree. That is the whole
point of the change, and it is why the calendar move landed as its own
no-behaviour-change step first: the diff that moves code and the diff that
changes answers are checkable in different ways, and mixing them destroys the
only check a reviewer of the larger one has.

The import path keeps its UTC reading, and that is now written down rather than
left looking like the defect it resembles. An Excel date serial counts days and
carries no zone, so `read-excel-file` decodes it to midnight UTC, and the value
goes on into a `@db.Date` column that is read back the same way. A spec pins the
library's half of that contract, because a version that ever decoded to local
midnight would shift every imported move-in date by a day in silence and nothing
else would say so.

Applying the association's zone to a `@db.Date` column is a **new** defect, and
a sweep that "fixed" every date-slicing call site would introduce dozens of
them. Around thirty-seven such call sites remain in the API and the large
majority are columns. Each one is decided against the schema.

A handful of sites read UTC fields and are correct for reasons that have nothing
to do with zones; they are left alone and the reasons are recorded where they
sit. The storage key's year and month go into an opaque object path that is
never parsed back, never shown and never compared. `import-columns.ts` slices a
`Date` it built from `T00:00:00.000Z` two lines earlier, as a round-trip check
that rejects the 30th of February. `role-changes.ts` produces a UTC-midnight
`Date` compared against a `@db.Date` column, which is what makes both sides the
same kind of thing. And the month-length trick
`new Date(Date.UTC(year, month, 0)).getUTCDate()` operates on plain integers,
where `Date.UTC` is the platform's proleptic Gregorian calendar and carries no
zone at all.

Nothing here can be proved end to end. In a UTC container the defect and the fix
agree for all but an hour or two a day, so a browser test would pass against
either for most of the day and fail for neither reason at midnight. The proof is
unit and integration, at a boundary-crossing instant.

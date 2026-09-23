# ADR 0016: Closing a granted erasure on evidence

Date: 2026-09-23

## Status

Accepted

## Context

A granted erasure request (GDPR art. 17) is carried out by six nightly jobs
rather than one. Five of them erase a person's rows in the domain those rows
belong to - bookings, chat messages, event sign-ups, motions, news comments -
and the sixth, the service-data purge at 03:53, erases the contact details and
the account and then marks the request executed and closes it.

Every one of the six selects a person by the request being open: granted, not
executed, not closed. So closing the request is the act that ends the erasure.
Rows still standing after it are rows no later run will come back for, and they
fall back to their ordinary retention window - a year for a chat message, two
years for a motion - instead of the date the board granted.

The sixth job closed the request whenever it found one. It did not ask whether
the five ahead of it had got through that person, and there are three ways they
do not:

- A per-person failure. Each of those runs catches an exception, logs it and
  carries on to the next person, so the queue sees a job that succeeded and does
  not retry it.
- The per-run bound. Each run took at most 500 people, ordered by the person
  column, and omitted the tail.
- A missed occurrence. The queue skips a schedule the instance was down for
  rather than catching it up, so a night the instance came back at 03:50 has the
  closing job run and the five readers not.

Ordering the five before the closing job is necessary and was done: they run at
03:07, 03:11, 03:29, 03:41 and 03:47, and a test over the source keeps them
there. It is not sufficient, because none of those three ways leaves the order
broken. It leaves the rows.

## Decision

### The closing job closes a request only when nothing of that person's remains

Before it writes `executedAt`, the service-data purge counts, inside the
transaction that erases, what each erasure-aware domain still holds for that
person. If any of them holds anything, the request stays open and the next
night tries again.

The erasure itself is not held back. The contact details, the account and the
open invitations go that night whatever the other domains hold: what waits is
the record saying the erasure was carried out, and holding the rest back would
leave a person's contact details on file for as long as the slowest domain took.

### One expression per domain, used by the act and by the evidence

`apps/api/src/retention/erasure-domains.ts` states, per domain, the rows a
granted request erases there. The domain's own job deletes exactly that
expression, and the closing job counts exactly that expression. A verification
written separately from the delete would be a second opinion about what "nothing
left" means, and the two would drift.

### The registry is checked against the source, not kept by hand

A hand-kept list of domains fails the way the original defect did: by being
remembered once and then not. `erasure-domains.spec.ts` walks the source for
every file that reads granted erasure requests and registers a schedule, and
fails for one that is not in the registry - and for a registry entry whose file
has gone, stopped reading requests or stopped being a job. It shares that walk
with the test that keeps the jobs in order, so a domain added later is held to
both rules without anybody remembering either.

### A request left open says which of two things it is waiting on

Two reasons, and they mean opposite things:

- **blocked** - a legal hold, a restriction of processing, a board seat, a
  system role, a residency that has not ended, or a motion the association is
  still dealing with. The purge must not overrule any of these, so the request
  waits for one of them to change rather than for anybody. Expected, and logged
  as an ordinary line.
- **incomplete** - rows a job owed and has not erased, or a purge that threw for
  this person on this run. The next run takes it. Warned about, because nothing
  else would report it: a request held open by a hold and a request held open by
  a job that keeps failing look identical in the database.

The run's summary carries the same account, and the audit entry written when a
request finally closes names the domains that were verified empty.

"Blocked" rather than "protected" or "withheld", both of which are taken. In
this product protected personal data (skyddade personuppgifter) is what
`kind: "protected"` means everywhere a person is returned to a screen, and
"withheld" is the state an apartment or a holder is in because of it - which the
debiting list and the fee notice then print as the literal word "protected". A
status on a log line beside a person id that reused either would be a false
signal for an ordinary member and would read as a disclosure for a real one.
"Kept" was not free either: `ERASURE_DOMAINS` already has a kept clause and a
kept count a few lines away, meaning the rows a domain holds on purpose.

### The people a granted request names are taken before the per-run bound

The bound exists so that the first run on an instance with years of data behind
it cannot erase all of it in one transaction-per-person loop. Nothing is lost by
stopping, because eligibility is computed from the data rather than marked on
it - except for a granted request, which is a flag the closing job clears the
same night. So each of the six jobs asks for the people a request names first,
and what is left of the bound is what its own retention window may take. A run
is 500 people, or as many as there are open granted requests where that is more.
What the bound still does is stop a run erasing years of retention-window work
in one loop; what it no longer does is cut somebody the board granted an erasure
to.

## Consequences

An erasure now finishes when it has finished rather than when the clock says so,
and the date on the record is one the board can rely on. A granted request can
stay open for longer than a night, and a board reading one is told what it is
waiting on.

An open motion keeps a request open indefinitely, because EFL 6 kap. 15 §
gives the member who put it the right to have it treated at the meeting and the
motion purge leaves it standing. That is a matter the board can close itself,
and it is reported as blocked rather than as a fault.

A person whose request cannot close yet is selected by the closing job every
night while it is open. That is one transaction and a count per domain, and it
writes no audit entry on a night it erased nothing - an entry a night, in a
table nobody can tidy, is what the old `return null` was avoiding and what this
keeps avoiding.

The verification is taken inside the erasing transaction, which is
READ COMMITTED. A row written into one of those domains between the count and
the commit would be left behind a closed request. It is a sub-second window and
the person is by then a former resident whose account is being deleted in that
same transaction, so there is nobody to write it; locking six tables per person
to close it would make every writer in the house wait on the purge.

# ADR 0016: Closing a granted erasure on evidence

Date: 2026-09-23

## Status

Accepted

The Context, Decision and Consequences below describe the state before the
2026-09-29 update. Read the update at the end for the domains and the erasure
predicate that apply now.

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

The erasure itself is not held back by outstanding domain work. Where that is
what the request is waiting on, the contact details, the account and the open
invitations go that night whatever the other domains hold: what waits is the
record saying the erasure was carried out, and holding the rest back would leave
a person's contact details on file for as long as the slowest domain took.

A refusal is the other thing, and it holds back everything. A legal hold, a
restriction of processing, a board seat still held, a system role still granted
or a residency that has not ended keeps the person out of the scan altogether,
and one recorded after the scan selected them returns the transaction before any
write - by then it has taken two advisory locks and read two rows, and touched
nothing of theirs. So a request left open for one of those reasons is an erasure
that has not started, not one that is half done, and nothing here may be read as
promising otherwise.

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
  as an ordinary line. The reason distinguishes two cases that matter to whoever
  reads it: the first five name a rule and mean nothing of that person's was
  erased this night, while a motion names a domain and a count and means the
  erasure has happened and one row is staying.
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

## Update, 2026-09-29

Two things this record described have changed.

The domains. Key orders, subletting applications, the board mailbox (threads
linked to the person by `correspondentPersonId`) and the rest of the chat (group
memberships, read markers and reports) were holding a person's rows that no
domain counted, so a request closed with them standing. They are domains now,
and an open key order or subletting application is kept, as an open motion is.
Member charges and fee notices stay out on purpose: they are accounting records
kept for seven years under BFL 7 kap. 2 §, so art. 17(3)(b) exempts them.

The "blocked" case. The domain jobs used to erase on any open granted request,
checking only a hold and a restriction, while the closing job also refused a
board seat, a system role and a residency not yet ended. A request could then be
logged as blocked after the domain jobs had already erased rows, which is not an
erasure that has not started. Every job that erases on a request now selects on
the same predicate (`erasureRequestedPersonIds` and `isErasureInForce` in
`retention/withheld-persons.ts`), so "blocked" again means nothing was erased.

## Update, 2026-10-09

A consented subletting application whose period has not ended is kept, as an
open one is. The erasure used to take every closed application whatever its
`periodTo`, so a granted request for a member who had since sold the flat erased
the board's consent to a letting that was still running. The consent is the
board's proof that the letting was lawful (BRL 7 kap. 18 § 2), and while a
subtenant lives there it is not the member's data to take away. The closing job
counts it as kept, so the request stays open; the first run after the period's
last day erases it and closes the request.

## Update, 2026-10-10

The update of 2026-10-09 keyed the keep to `periodTo`, a date the applicant
chooses, and nothing could shorten it. A consent to a letting that stopped
early, because the subtenant moved out or the member sold, then held a granted
request open until the end of a period nobody was using. Two things bound that
now.

The period is bounded where it is entered. An application or a revision whose
period ends more than five years from that day is refused
(`period-too-far-ahead`), so a mistyped year cannot hold an erasure open for
generations. The bound was added with #246 for the retention clock, and it
serves this keep as well.

The board can record that a letting ended. `PUT
api/sublet-queue/:id/letting-end` writes `lettingEndedOn`. Only a consented
application can carry it, the day must fall inside the period, and the board
can clear it again. The day is audited as `SUBLET_LETTING_END_RECORDED`. From
that day on, the recorded day is the letting's last day wherever the period's
was read. A granted request then erases the consent and can close the first
night after it, and the retention window counts from it. The period itself
stays what the board consented to.

We did not derive the end from the register, for example by capping the keep
at the member's move-out from the apartment plus a window. The update of
2026-10-09 keeps the consent because a subtenant can still live in the flat
after the member has left the register. A cap tied to the move-out would make
the platform guess the opposite, and only the board knows which is true.

The residual: a consent the board never records as ended is kept until its
period ends, at most about five years after it was applied for. In the
meantime the rest of the erasure is carried out as the Decision describes. The
contact details and the account go on the first night, and only the
application and the open request wait. The board does not yet see on the
request itself that a consent is what it waits on. That reaches the run's log
and the audit entry, not the screen.

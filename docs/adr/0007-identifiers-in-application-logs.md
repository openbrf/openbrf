# ADR 0007: Identifiers in application logs

Date: 2026-09-06

## Status

Accepted

## Context

An application log is outside every tier the retention policy governs. It is
collected, shipped and kept on a schedule the operator sets, read by whoever
operates the instance, and copied wherever those copies go. No purge reaches it,
the audit log's access control does not cover it, and an erasure request cannot
be executed against it. Anything written there is a copy of its subject held
where the policy that governs the original cannot follow.

Against that stands what the log is for. The jobs that write most of it are the
jobs the retention policy depends on. Each nightly purge erases service-tier
data on a date, one person per transaction, and records the erasure as a
`SERVICE_DATA_PURGED` entry inside the transaction that erased - which is what
makes the entry evidence rather than a claim. A transaction that throws takes
its entry with it. So a failed erasure leaves no row anywhere saying it was
attempted: the run's summary counts it, and a count is not a handle. Erasure on
the date is an obligation, and an erasure that did not happen and cannot be
located is that obligation still outstanding with nothing naming what is
outstanding about it.

`apps/api/src/logging/failure.ts` already settles half of the question. The
class of the failure travels and its message does not, because a message is
composed where it is thrown out of whatever was being handled: a mail server's
rejection quotes the envelope, a constraint violation names the value that broke
it. What that file did not say is whether the identifier travelling beside the
class may be a person's.

It may. This records that, and the boundary it sits on, so it is a rule with a
place rather than a decision each new job takes again.

## Decision

### An identifier the application minted may be logged

A log line may carry the class of the failure, its runtime code, and the primary
keys of the rows the work was about: a person id, a residency id, a booking id,
a thread id, a stored file id, an import session id, a plugin id. These are
surrogate keys - values this application generated to address a row, carrying
nothing about who or what the row holds.

The argument for allowing them is what they are worth and what they are not. A
surrogate key discloses nothing to a reader without the database, and a reader
with the database can read the register itself; what the key does is name the
row, which is the whole of what an operator needs to retry the work that did not
happen. The argument that it is still personal data is correct and is not the
end of it: a pseudonymous key in a log that is retained and access-controlled is
a smaller exposure than an obligation nobody can discharge.

### Nothing that identifies without the database may be logged

Names, email addresses, telephone numbers, postal addresses, personal identity
numbers (personnummer), apartment identity, and any free text belonging to a
row - an issue description, a rejection reason, a document title, an
application's stated reason. Nor an exception message, which is why
`failureName` exists, nor anything else read out of the row being processed.

The line is between a value the application chose in order to address something
and a value it is holding on somebody's behalf. The first is an address; the
second is the data.

### The purges keep the person id, and each says so the same way

Every nightly purge logs the failure class and the person the erasure was for,
in one shape, in the `catch` around its per-person transaction. The comment at
each site names this decision instead of restating it, so the eight of them
cannot drift into eight different answers and a ninth purge inherits the rule
rather than deciding it.

### The audit log is not the substitute for it

The obvious alternative - drop the id from the log and record the failure as an
audit entry instead - trades a copy bounded by log retention for one bounded by
nothing. The audit log is append-only at the database level, exempt from every
purge, and has no correction path by design; a person named there is named for
as long as the instance exists. Recording every failed erasure there would make
the audit log the one place a purge can never finish.

It also would not work when it is needed. The entry would have to be written
outside the transaction that failed, against the database that has just refused
the write, so the case the record exists for is the case in which the record is
least likely to be written.

That leaves the correlation between a run and its lines, which does not need the
audit log: a run's lines are already contiguous in one job's output, and each
purge logs its summary at the end of the run whose failures precede it.

### The rule is the same everywhere, not only in the purges

It covers the same shape wherever it appears - the delivery jobs logging a board
member a notice did not reach, the move import logging a session and a residency,
the mailbox collector logging a thread and a stored file. Those sites were
already written this way; naming the rule here is what makes that agreement
deliberate.

## Consequences

- **Log retention is a data protection control on this deployment.** The
  operator decides how long the container logs are kept and who may read them,
  and that decision now sits inside the retention posture rather than beside it.
  `docs/deployment.md` says so where it describes the nightly purge.
- **A failed erasure remains visible only in the log.** It is found by reading
  the job's output, not by a screen, and it is lost when the log rolls. That is
  the standing cost of this decision and the first revisit trigger below.
- **The rule is enforceable in review.** The path instruction that flags personal
  data written to logs carries the carve-out, so an identifier in a purge failure
  line is not raised as a finding and everything else still is.

## Revisit triggers

- **A failed purge gains a durable record of its own.** An outstanding-erasure
  row, held in the service tier under its own retention and read by the retention
  screen, would give the operator a handle inside the governed tier - at which
  point the id in the log line is a duplicate of it and can go. This is the
  change worth making if the failure ever stops being rare.
- **Logs leave the instance.** Shipping them to a third-party collector makes the
  operator's retention decision somebody else's, and the processor register has
  to answer for it before an identifier may travel there.
- **An identifier stops being opaque.** A key derived from a personnummer, or a
  slug built out of a name, is not a surrogate key and is not covered by this.
- **A purge's unit of work stops being a person.** The charge purge already logs
  a party that may be an apartment rather than a person; a unit that is itself
  descriptive rather than an address would need its own answer.

# ADR 0057: Purging issues in two layers, and the access report

Date: 2026-11-02

## Status

Accepted, with the questions under [Open questions](#open-questions) left to the
owner and to the legal review the issue module plan names. Amends
[ADR 0019](0019-every-column-that-names-a-person-is-answered-for.md): a column
naming a person somebody else chose is answered by a section, and this record
says which. The fourth of four records for the issue module (ADRs 0054 to 0057),
citing that plan's decisions by number as
[ADR 0054](0054-issue-types-statuses-and-outcomes.md) does.

It changes what `ROADMAP.md` says of purging issues, that "an issue's own
description is free text the reporter wrote and is not rewritten". That line
changes in the pull request that ships the purge below, as `ROADMAP.md` asks.

## Context

No clock deletes anything from an issue today. The person purge detaches a
reporter on their own window and keeps the description and every photograph:
"a job rewriting prose on a schedule would be the association quietly editing
its own history" (`purge.service.ts`). A report from the website's form has its
contact details purged 365 days after `closedAt`, by `IssuePurgeService`, which
selects `status: "DONE"` literally. A person named in a description makes an art.
17 request, and the schema says "what is then done to the text is the board's own
act on the issue"; no route performs that act.

The market research for the plan found that conflict: a building's record can
outlive its people, while free text and photographs of somebody's home cannot
simply stay for ever. The owner decided (decision 33) on two layers. The building
facts stay: what, where, when, outcome. Free text, the conversation and the
photographs are removed on a clock after closing, unless a legal hold applies.
The board sets the clock from one to ten years, two by default. Handlers can
redact text or remove a photograph at any time.

The module also adds columns that name people: an assignee, the author of an
issue message and of an internal note, the handler who entered a case, and a
type's default assignee ([ADR 0054](0054-issue-types-statuses-and-outcomes.md)).
ADR 0019 requires each to be answered for in `COLUMN_COVERAGE`. Its `actedAs`
answer holds only where the service records the act with that column's person as
the actor, and an assignee chosen by somebody else did not act.

## Decision

### Two layers

**What stays** is the case's building record: its type, the place from the
common-area list (decision 30) and the apartment where there is one, when it was
reported and closed, the meanings it passed through, its priority, its outcome,
and whether it was a damage case. None of it is text a person wrote, and a case
with no reporter, no conversation and no photograph is what makes a repeat fault
countable.

**What goes** is everything a person wrote or photographed: the description, the
free-text location, every issue message and internal note, the text of every
work order and the contractor's notes, and every photograph and every file a
contractor uploaded, removed from storage and not only unlinked. What stays of a
work order is the record of who received it and when, and which kinds of data it
carried, because that is what art. 15(1)(c) and art. 19 ask the association to
answer (decision 23); its words go with the rest. The free-text
location goes with them because decision 33 removes free text, and "the bathroom
in 1101, the neighbour's dog" is free text whatever field it was typed into.

A case whose free text is gone says so on the board's screen, with the date,
rather than showing an empty description.

### The clock

The free-text layer is removed when the case has been in the `DONE` meaning for
the board's setting, counted from `closedAt`. The setting is a whole number of
years from 1 to 10, 2 by default, and the board sets it. Two has no legal source: it matches motions, subletting and the
board mailbox here (decision 33). A ring-fenced type has a clock of its own, one
year after closing, which the board cannot change while the legal review of
decision 32 is pending.

A case reopened before its date stops the clock, because reopening clears
`closedAt`. The 30 days in which a reply reopens a case (ADR 0054) are inside the
shortest clock.

The clock does not run while a legal hold applies:

- **on the case**, which marking a case as a damage case sets (decision 28) and
  which is placed and released with a date, as a person's legal hold is;
- **on its reporter**, a legal hold or a restriction under art. 18, as the
  website form's purge already reads one through the reporter's address index.

### The purge reads the meaning

Both purges select cases in the `DONE` meaning, never a status by its label or a
literal `"DONE"`. A status a board adds under `DONE` therefore closes a case for
the purge as Klar does; a case in it is never kept for ever because its label is
new.

`closedAt` stays written under `lockIssue`, on the move into `DONE` and not on a
move between two `DONE` statuses, because a wrong value moves the purge earlier.

### Redaction

A handler the case lets in may at any time redact the text of a description, a
location, an issue message, an internal note or a work order, and remove a
photograph or an uploaded file. Redacting replaces the text with a mark saying
it was redacted and when; nothing keeps the earlier text, so a redaction is not
an edit with a history. Removing a file removes it from storage.

Each act is recorded in the audit log against the case, by its own action, with
the field it reached and never the text (the rule that an entry's context holds
facts and never free text, `audit-log.service.ts`). The text a handler writes in
place of a redaction is not offered: a redaction is a removal, and a field for
new words would be an edit.

This is the board's own act that an art. 17 request about a description promises.
A granted request naming an issue (`DataSubjectRequest.issueId`) is carried out by
a handler redacting what the decision covers.

### Erasure and the closing job

The clock is case-keyed and reads no request, so its job is not an erasure
domain. The person purge keeps detaching: on a person's own window, and on a
granted erasure request, the closing job at `53 3` nulls every column on an issue
that names that person, the new ones included, and leaves the building record
and the text, as today. Each new column joins `referencedPersonIds`, or a person
named only there would never be selected.

If a later decision makes a granted erasure remove a reporter's own words from a
case by itself, rather than through a handler's redaction, that job reads granted
requests, registers in `ERASURE_DOMAINS` and runs before `53 3`, as
`erasure-domains.ts` requires of any such job. This record does not make that
decision (question 2).

### The access report

The `issues` section keeps reading the cases a person reported, and gains what
the module adds to them: the status's meaning, the outcome, the issue messages
the reporter can read on their own case, and the date the free-text layer is
removed, now that one exists. It never carries the assignee, a handler's name or
an internal note's author.

**A column naming a person somebody else chose is answered by a section** (this
amends ADR 0019). An assignee and a type's default assignee are such columns: the
person named did not act, so `actedAs` does not hold, and the audit entry for the
assignment names the assigner as the actor. Both are answered by a new section,
**`issueAssignments`**: each case the person is assigned, and each type naming
them as its default assignee, with the case number, the type, the meaning it is
in and the dates. Never its description, its location, its reporter or its
conversation: the case is somebody else's report, and art. 15(4) keeps another
person's data out of this one's copy. It maps to the `issues` row in the record
of processing activities.

The other new columns name somebody who acted, and each is answered by `actedAs`
where its service records the act with that person as the actor: the handler who
entered a case, the author of a handler's message, the author of an internal note.
An issue message the reporter wrote is answered by the `issues` section, as the
reporter column is.

## Open questions

Calls the plan does not make, left to the owner and, where marked, to the legal
review:

1. **Internal notes about a reporter, under art. 15** _(legal review)_. A reporter
   never sees an internal note on the screen (decision 18). An internal note
   about them is personal data about them, and art. 15 gives them a copy unless
   an exemption applies. Whether the `issues` section carries them, and under
   which exemption it would not.
2. **Whether a granted erasure removes a reporter's words by itself**, through an
   erasure domain, or leaves that to a handler's redaction as decided above.
3. **A neighbour's report in somebody else's access report** _(legal review, art.
   15(4))_: a case about a person who did not report it, where that person asks
   for their data.
4. **The ring-fenced clock** _(legal review)_: whether Störningar may be held this
   way at all, for how long, and art. 10 on an allegation (decision 32).
5. **The timeline** (decision 16): if it is a table of its own rather than read
   from the audit log, each person column on it needs its own answer here.
6. **A contractor's own data**, a sole trader's name and telephone number in the
   contractor register, which is not a person in the register: on which report,
   and on which clock.

## Consequences

- `IssuePurgeService`, or a job beside it, removes the free-text layer on the
  board's clock; the website form's contact details keep their own 365 days. The
  record of processing activities' `issues` row states both, and its subjects gain
  board members, former residents and the property manager.
- `COLUMN_COVERAGE` gains an entry for every new column, and the `gap` list stays
  at four. `DATA_SUBJECT_REPORT_SECTIONS` gains `issueAssignments`, held to both
  applications' report types and printed by the document.
- A photograph is removed from storage for the first time, by the clock and by a
  handler. The person purge's comment that nothing is removed from storage
  narrows to the person purge itself.
- The art. 17 promise on `DataSubjectRequest.issueId` gets the route it names.

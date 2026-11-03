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
domain. The person purge keeps detaching: on a person's own window, and on a granted
erasure request, the closing job at `53 3` nulls every column on an issue that
names that person, the new ones included, and leaves the building record, as
today, with one exception: **the reporter column of a case whose free-text layer
still stands is not cleared, whether or not an erasure request exists.** The
layer stands while the case is open, while a closed case waits on its clock or
on a hold of its own, and while the issue erasure job still owes it. A person's
own window can run out, and a request can be granted later, with the text still
there: a person purge that detached the reporter on the first night would leave
nothing that ties the case to the person, so a request granted afterwards could
find no case, and would close without erasing the text. The reporter column is
what ties such a case to the person, for the issue erasure job's selection, for
the remainder count and for the access report, so it stays until the text is
gone.

It is cleared by what removes the text: the clock job, the issue erasure job or a
handler's redaction of the last of it clears the reporter column in the
transaction that finishes the case, once the person's own window has run out or
a request naming them is executed. For a granted request, the closing job also
refuses to mark it executed while the issue job's owed and kept counts for that
person are not both zero (above). The account and contact data of the person,
and every other column naming them, are still cleared promptly as
[ADR 0016](0016-closing-a-granted-erasure-on-evidence.md) requires; only this
one reference waits, and it waits on the case, not on the person's account.
Should the implementation prefer it, an independent person-to-issue work record
that survives detachment satisfies this equally, as long as it holds the case id
and the state (text still standing, owed, kept and why, done) and never the text.
Whichever is chosen, no case whose text still stands may lose its selector.

Detaching is not erasing what the person wrote, and a clock that removes it
later is no evidence that the erasure was carried out. The closing job marks a request executed and closes it, and
`erasure-domains.ts` says what follows: no job finds the request after that, and
a row still standing falls back to its ordinary retention window instead of the
date the board granted. A case whose free text waits two years on the clock,
under a request the record calls executed, is exactly that. So issues get **an
erasure job of their own**, beside the clock and apart from it:

- **It reads granted erasure requests** and, for each person one names, removes
  what a granted erasure reaches in the issues module (below) on the date the
  board granted rather than on the case's clock.
- **It registers in `ERASURE_DOMAINS`**, with a key the board's screen names it
  by, a count of what it still owes and a count of what it keeps and why. One
  where-input states what the erasure reaches: the job removes exactly that, and
  the closing job counts exactly that before it writes `executedAt`, so a
  request whose issue rows are still standing stays open and says which domain
  holds them. `erasure-domains.spec.ts` finds the job by walking the source and
  fails while it is unregistered.
- **It runs before `53 3`**, which `erasure-request-order.spec.ts` holds it to
  by the schedule it registers. It must: the closing job nulls the reporter
  column, and a job running after it would find neither the open request nor
  the cases it is about.
- **It takes the people a request names first**, before its own bound, as
  `remainingRunBound` asks of every such job.

What it reaches:

- **Every case the person reported that is in the `DONE` meaning**: its
  free-text layer, as [Two layers](#two-layers) defines it and as the clock
  would remove it, photographs and files removed from storage. The building
  record stays, and the reporter is detached from it once this job has
  finished the case (above).
- **Kept, and counted as kept**: a case the person reported that is not in the
  `DONE` meaning, which is still with the board as an open key order or motion
  is ([ADR 0016](0016-closing-a-granted-erasure-on-evidence.md)), and a case
  under a legal hold of its own, such as a damage case. Each holds the request
  open, with its reason, until the case closes or the hold is released.

A person named in a case somebody else reported is not reached by this job. That
is the request naming an issue (`DataSubjectRequest.issueId`), carried out by a
handler's redaction (above). What of a merged case's text the job reaches, and
whether a request naming an issue is held open until the redaction is done, are
open (question 2).

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

A former assignee is answered by the audit log. The entry of an assignment that
takes a case from somebody, or of a type's setting that shuts them out, names
them only as the previous assignee in its context, so the report lists it among
their entries as one about them, and withholds the previous assignee from the
entry of the person it was given to, who is told only that the case had one.

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
2. **Where the issue erasure job stops.** The job itself, its registration and
   its place before `53 3` are decided above; two edges of what it reaches are
   not. A merged case (decision 22) carries more than one reporter's words: whether
   one reporter's erasure removes the case's whole free-text layer, or only what
   that reporter wrote and what was written to them. And whether a request naming
   an issue (`DataSubjectRequest.issueId`) is counted by the closing job, so that
   it stays open until a handler has redacted what the decision covers, rather
   than being closed with that act still owed.
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
- An issue erasure job reads granted requests and runs before `53 3`.
  `ERASURE_DOMAINS` and `ErasureDomainKey` gain its domain, with the board's
  screen's words for it in both languages, and the list of domains in the
  comment over `erasure-domains.ts` names issues.
- `COLUMN_COVERAGE` gains an entry for every new column, and the `gap` list stays
  at four. `DATA_SUBJECT_REPORT_SECTIONS` gains `issueAssignments`, held to both
  applications' report types and printed by the document.
- A photograph is removed from storage for the first time, by the clock, by the
  issue erasure job and by a handler. The person purge's comment that nothing is
  removed from storage narrows to the person purge itself.
- The art. 17 promise on `DataSubjectRequest.issueId` gets the route it names.
- The person purge's and the closing job's blanket detachment narrows: the
  reporter reference of a case whose free-text layer still stands survives until
  the clock job, the issue erasure job or a redaction has removed the text, or the
  keep ends (or an independent work record carries the selection). The
  implementation verifies this with at least two nightly runs for each of three
  cases: an issue purge that fails on night one, an open or held case, and a
  person whose own window runs out while a closed case still waits on its clock,
  with a request granted afterwards. After
  night one the request is still open, the case is still selected and counted, and
  the person's account and contact data are already cleared; the retry, the
  closing or the release then completes the erasure on a later night, the
  reporter reference clears, and only then does the request close. Registering
  and scheduling the job is not completion evidence on its own (ADR 0016).

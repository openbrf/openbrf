# ADR 0057: Purging issues in two layers, and the access report

Date: 2026-11-02

## Status

Accepted, with the questions under [Open questions](#open-questions) left to the
owner and to the legal review the issue module plan names, except question 4,
which the legal review answered on 2026-11-09
([below](#the-legal-reviews-answer-to-question-4)). Amends
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
contractor uploaded, removed from storage and not only unlinked. The record of
whom the case concerns goes with them ([The people an issue
concerns](#the-people-an-issue-concerns)): nobody wrote it as text, but it is
what the case holds about a named person, and it says nothing of the building
that the apartment and the place do not. The record goes, but where a work
order's text stands, which has its clock, a bare row stays as the selector a
later hold or restriction finds that text by, until the last of it is erased
(see the same section). What stays of a
work order is the record of who received it (until the board removes that
contractor from the list, which clears the name and address, or, once the list's
own clock has taken the contractor off it, for as long as the work order keeps
its text or a legal hold stands on its issue; see
[The contractor register](#the-contractor-register)) and when, and which kinds of data it
carried, because that is what art. 15(1)(c) and art. 19 ask the association to
answer (decision 23); its words go too, on a clock of their own (below). The free-text
location goes with them because decision 33 removes free text, and "the bathroom
in 1101, the neighbour's dog" is free text whatever field it was typed into.

A case whose free text is gone says so on the board's screen, with the date,
rather than showing an empty description.

### The clock

The free-text layer is removed when the case has been in the `DONE` meaning for
the board's setting, counted from `closedAt`. The setting is a whole number of
years from 1 to 10, 2 by default, and the board sets it. Two has no legal source: it matches motions, subletting and the
board mailbox here (decision 33). A ring-fenced type has a clock of its own,
which the board sets apart from the other: a whole number of years from 1 to
10 after closing, 1 by default, and every instance starts at 1
(`Association.ringFencedIssueTextRetentionYears`, bounded by
`RING_FENCED_ISSUE_TEXT_RETENTION_YEARS` in `@openbrf/shared`). Neither clock
is held to the other: a ring-fenced clock may be longer than the other types'
or shorter. The purge reads both settings when it runs, and whether a type is
ring-fenced on every run, so a type ring-fenced later brings its closed cases
onto the ring-fenced clock from the next night. Before the legal review this
was a fixed year the board could not change, and the purge took the shorter of
it and the board's setting; the migration that made it a setting starts every
instance at that year, so no pending date moved.

A legal hold stands over the ring-fenced clock as it does over the board's: the
purge skips a case under a hold, ring-fenced or not, until a handler releases
it. That includes a damage case, which places a hold without a word to the
handler who marks it. A legal hold or a restriction on the case's reporter
stops the purge on either clock as well. A ring-fenced case under any of these
therefore keeps its text past its clock, and the texts that state the clock
name both: a legal hold on the issue, or a legal hold or a restriction on the
person who reported it. The legal review confirmed that a legal hold may stand
on a ring-fenced case (question 4, below).

The text of a work order has a clock of its own too: ten years after closing
(3,653 days, so never before the tenth anniversary and up to a day after it),
whatever the board's setting. The owner asked on 2026-11-03 for it to be kept as
long as the law allows. Ten years is the ordinary window chosen for that, sized
to the general limitation period for a claim about the work
(preskriptionslagen (1981:130) 2 §); it is not a period the law sets for the
text, and a legal hold keeps a text the window would end too early (below). The reasons are in [ADR 0055](0055-links-for-reporters-and-contractors-without-an-account.md#the-mailed-work-order).
The nightly issue purge already erases it on that clock (`WORK_ORDER_BODY_RETENTION_DAYS`),
and a handler may redact it sooner ([Redaction](#redaction)).
A report from the website's form is tied to its reporter only by the address
index, so the purge that removes its contact details after 365 days keeps that
index while a work order's text stands, and the transaction that erases the last
text clears it: a hold or a restriction placed later on the person who wrote in
still reaches the text (see [Erasure and the closing job](#erasure-and-the-closing-job):
no issue whose text stands may lose its selector). An issue reported by a person
in the register keeps its reporter column the same way: the person purge does
not detach it while a work order's text stands, and detaches it on a later run
once the text is gone. For a person whose erasure request has been executed,
whom no later run selects, the transaction that removes the last text on the
issue clears it: the work-order text purge once the free-text layer is gone too,
or the removal of the free-text layer (by the clock, the issue erasure job or a
handler's redaction) once no work order's text stands.

A case reopened before its date stops the clock, because reopening clears
`closedAt`. The 30 days in which a reply reopens a case (ADR 0054) are inside the
shortest clock.

Neither clock, the free-text layer's or a work order's text's, runs while a
legal hold applies:

- **on the case**, which marking a case as a damage case sets (decision 28) and
  so does the first mark of an inspection finding, where none stands (decision
  31), and which is placed and released with a date, as a person's legal hold
  is. It is one date with no reason beside it, so taking the finding's mark off
  leaves it, and a handler releases it as any other; a mark put on again after
  that is a new finding and places it again;
- **on its reporter**, a legal hold or a restriction under art. 18, as the
  website form's purge already reads one through the reporter's address index;
- **on a person it concerns**, a legal hold or a restriction under art. 18, read
  by their person as a signed-in reporter is: the text is what the case holds
  about them as well.

### The contractor register

The answer to question 6, which the legal review gave and the owner accepted on
2026-11-09. A sole trader's name, telephone number and email address are
personal data, and so are a firm's contact person's. The association's list of
contractors holds all three. A work order written to them keeps its own copy of
the name and the email address it was mailed to, but not the telephone number,
which is for the handler and is sent nowhere.

- **The basis.** The contract (art. 6(1)(b)) for a contractor who is a sole
  trader, and the association's legitimate interest in hiring and reaching the
  firm (art. 6(1)(f)) for a firm's contact person. The record of processing
  activities' `issues` row states both.
- **The information.** A contractor who gives the board their details
  themselves is owed the information when they give them (art. 13(1)); one whose
  details the board takes from somewhere else, such as the firm's own website or
  the firm a contact person works for, is owed it within a reasonable period
  and at the latest a month after the board obtained them (art. 14(3)(a)), and
  sooner if the board writes to them before that month is out: at the latest
  with that first communication (art. 14(3)(b)). The month is the outer limit
  whichever comes first, as the EDPB's transparency guidelines (WP260 rev.01)
  read the article. Open BRF cannot tell which of the two happened, nor when the
  board obtained the details, and a work order meets neither deadline on its
  own, because it may come later or never. So the board points a contractor
  who gives their details themselves to the privacy notice when they do, and
  one whose details it found elsewhere within a month of finding them, unless a
  work order has gone to them by then, as the contractor list's description
  asks. As the means for the first communication, and as a backstop for both,
  the first work order mailed to a contractor links the association's privacy
  notice, the page on
  its public website every visitor reads, which is not a link into the
  application and carries nothing from the issue. A later work order does not
  repeat it. The list records when a mail that carried the link was accepted by
  the mail server (`privacyNoticeGivenAt`); a mail that was refused or that
  nobody can vouch for leaves it unset, so the next work order carries the link,
  and the board changing the contractor's name or address clears it, because
  whoever reads that address now has not been told. The mark speaks only for
  the name and address the list holds: a work order written to an earlier name
  or address, still queued when another work order to the new ones set it,
  carries the link all the same. A work order that must carry the link is never
  sent without it. While the notice is not on the public website for anyone to
  read (missing, a draft, or for members only), the handler is refused the
  preview and the sending of such a work order (`work-order-privacy-notice-unpublished`),
  and one already queued when the notice was taken down is recorded as not sent
  (`privacy-notice-unpublished`), for the handler to write again once the board
  has published the notice. A work order to a contractor already told goes out
  as before.
- **The clock.** A contractor is removed from the list ten years after the last
  work order sent them, or after the board added them if none was, counted as
  a work order's text is (3,653 days, `CONTRACTOR_RETENTION_DAYS`). The anchor
  is the general limitation period for a claim about the work
  (preskriptionslagen (1981:130) 2 §), the same one a work order's text keeps
  to. The nightly issue purge takes them off the list on that clock alone: the
  row goes, with the name, the trade, the telephone number and the address the
  list held, whether or not a work order written to them still holds its text, and
  whether or not one is on an issue under a legal hold. The list is the
  association's means of hiring, and it does not wait on a record whose clock
  runs from an issue's closing, which may come years after the last work order
  or not at all. A work order is that record, and keeps its own copy of whom it
  went to, the name and the address it was written to, for as long as it keeps
  what it said: one that still holds its text, or is on an issue under a legal
  hold, keeps the copy, named by no contractor on the list. The copy goes with
  the text, whether the work-order text purge erases it or a handler redacts it,
  and on a work order whose text is already gone, with the release of the hold.
  The others lose it when the contractor goes. A work order whose mail is known
  never to have left Open BRF (`deliveryStatus` FAILED with any code but
  `delivery-unconfirmed`) does not count as sent them: no claim about the work
  rests on a mail the firm never got. A work order's
  own record keeps its ten years after its issue closed, as above; this clock
  changes nothing of it.
  The board can remove a contractor sooner, which is how a sole trader's
  erasure request is honoured ([ADR 0055](0055-links-for-reporters-and-contractors-without-an-account.md#the-mailed-work-order)).

A contractor is not a person in the register, so no data subject access report
is generated for one: the board answers a contractor's request from the list
and the work orders written to them. Once the clock has removed a contractor,
no contractor on the list names the work orders that kept their name, so the
issue queue's search matches the name a work order was written to. The board
handles every issue, and its search for the name in the All view, with closed
issues included and no other filter, finds every work order that still holds
it: Mine and Unassigned hold only some issues, and Overdue only open ones. The address is stored encrypted
and is not searched, as a reporter's from the website's form is not. Invoices follow bookkeeping law
(bokföringslagen (1999:1078) 7 kap. 2 §) outside Open BRF. Whether a work order
is räkenskapsinformation is left open by the review.

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
an edit with a history. Removing a file removes it from storage. A work order
whose text is redacted stays on the issue with whom it went to and when, which is
the record of the disclosure. The recipient's name and address stay for as long
as the contractor is on the list and go if the board later removes them
([ADR 0055](0055-links-for-reporters-and-contractors-without-an-account.md#the-mailed-work-order)).
Where the list's own clock has already taken the contractor off it, the copy the
work order kept for its text's sake goes with the redaction. A copy outlives
its text only on an issue under a legal hold, where the text was already gone
when the clock ran; it goes when the hold is released. One whose mail has not gone out yet is not sent,
and is recorded as not sent.

Each act is recorded in the audit log against the case, by its own action, with
the field it reached and never the text (the rule that an entry's context holds
facts and never free text, `audit-log.service.ts`). The text a handler writes in
place of a redaction is not offered: a redaction is a removal, and a field for
new words would be an edit.

This is the board's own act that an art. 17 request about a description promises.
A granted request naming an issue (`DataSubjectRequest.issueId`) is carried out by
a handler redacting what the decision covers.

A redaction is refused while a legal hold stands on the case. The hold records
that the association needs what the case holds for a claim (art. 17(3)(e)), and a
redaction would remove it as surely as the clock the hold stops; the hold is
released first, which is its own entry in the log.

A redaction is refused as well while the case's reporter, or a person it
concerns, is under a legal hold or a restriction under art. 18, read as the clock
reads it: a signed-in reporter and a concerned person by their person, a
public-form reporter by the address on the report. The reason is
the one the clock stops for: the reporter's text is what that hold or restriction
keeps, and a handler's redaction would remove it as the clock would. The refusal
is the one a hold on the case gets: it does not say whether the reporter's is a
hold or a restriction, nor why, because a handler may not read a person's holds
and restrictions. A handler who sees no hold on the case can still tell that the
reporter has one or the other. Any refusal tells them that much, and the only
answers that would not are to remove the text regardless or to report a removal
that did not happen. It is also what a handler needs to know: art. 18 limits the
processing they would carry out, and a restriction is the marking of the data so
that whoever processes it can see that it is limited (art. 4(3), recital 67).
The reporter's hold is released, or the restriction lifted, where it was placed.

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

As built, the person purge clears the reporter column, and only from a case whose
free-text layer is gone. It runs at `53 3`, after the clock and the issue erasure
job, so a case either job finishes loses its reporter the same night, once the
person's window has run out or their request is executed, in the transaction that
records the person's purge; a case a handler finishes by redaction loses it on
the next night. The exception is a person whose erasure request has been executed
while a work order's text still stood: no later run selects them, so the
transaction that erases the last text clears the column, whether the clock erased
it or a handler's redaction did, unless a legal hold or a restriction keeps them.
The person purge's scan of reporter columns reads only finished
cases, so a person whose case still waits is not selected for it night after night.

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
  is ([ADR 0016](0016-closing-a-granted-erasure-on-evidence.md)), a case
  under a legal hold of its own, such as a damage case or an inspection
  finding, and a case concerning a person under a legal hold or a restriction,
  whose data the layer is as much as the reporter's. Each holds the request
  open, with its reason, until the case closes or the hold or the restriction
  ends.

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
takes an issue from somebody, or of a type's setting that shuts them out, names
them only as the previous assignee in its context, so the report lists it among
their entries as one about them, and withholds the previous assignee from the
entry of the person it was given to, who is told only that the issue had one.
The report finds those entries through a partial index on that context key, so
that it does not scan a log which only grows.

The other new columns name somebody who acted, and each is answered by `actedAs`
where its service records the act with that person as the actor: the handler who
entered a case, the author of a handler's message, the author of an internal note.
An issue message the reporter wrote is answered by the `issues` section, as the
reporter column is.

### The people an issue concerns

A case can be about somebody who did not report it: the neighbour a report of a
disturbance names, the household a leak came from. That person's data is in the
case, and art. 15 gives them a copy of it (EDPB Guidelines 01/2022, paras 96 and
104-105; C-487/21, para 44), so the association has to be able to find the cases
about them. The text cannot be searched for a person; a handler records them
(berörd person, `IssueConcernedPerson`), on an issue of any type, Störningar
above all.

- **Picked as a resident is picked**, from the apartments and then who lives in
  one today (`IssueResidentsService`), by residency, so the property manager
  names nobody a door would not show them. The list reads a name, or that the
  name is protected, keyed by the record and never by the person. At most
  `ISSUE_CONCERNED_PERSON_LIMIT` on one issue (ten).
- **Personal data of its own, in the free-text layer.** The record is what the
  case holds about the person named, so it is purged with the layer by the clock
  and by the reporter's granted request, and kept by whatever keeps the layer: a
  legal hold on the case, a legal hold or a restriction on its reporter, and a
  legal hold or a restriction on any person it concerns. A handler takes one off
  as a redaction (`ISSUE_REDACTED`, target `concernedPerson`), which deletes the
  row, under the same refusals: it is the way to correct a person recorded in
  error, and it leaves no selector, as the case was not about them. The person
  purge does not detach it: as the reporter column is, the record is what ties
  the case to the person while the text about them stands, and it goes when that
  text does.
- **A bare selector stays for a work order's text.** The free-text layer's
  removal, by the clock or by the reporter's granted request, leaves the
  work orders' text on its own ten-year clock. A legal hold or a restriction
  placed on a person the case concerns after the layer went must still stop that
  clock, and the person is found through the row, as a reporter is through
  the reporter column. So where any work order's text stands, the removal does not
  delete the row but writes `recordRemovedAt` on it: it is then no record. No
  handler reads it, it counts for no list, limit or free-text standing, and a
  handler who records the person again replaces it with a new record, so a
  removal asked on the earlier record's identifier is refused. It still ties
  the case to the person, so the access report's query for the cases
  concerning them (below) finds it for as long as the row stands, which is as
  long as the work order's text does.
  It names no more than the row did and is never written to the audit log. The
  work-order text purge and a handler's redaction of a work order's text delete
  it in the transaction that erases the last text, and the removal deletes the
  row outright where no text stands. The row still counts for protection: an
  issue concerning a person with protected personal data stays out of what leaves
  the instance for as long as it stands. A person's own erasure
  request does not reach a case somebody else reported, as above; a request
  naming the issue is carried out by a handler's redaction, the record included.
- **Read by the handlers the issue lets in, and nobody else.** Never by the
  reporter, in a mail, in a work order or through either link, and never on
  `mcp` or `ai`, where an issue concerning a person with protected personal data
  is left out as one such a person reported is
  ([ADR 0056](0056-issue-handling-on-mcp-and-ai.md)); a contractor's link to it
  ends, as it does for a protected reporter
  ([ADR 0055](0055-links-for-reporters-and-contractors-without-an-account.md)).
- **The log records the act and never the person.** `ISSUE_CONCERNED_PERSON_ADDED`
  names the handler as its actor and the record by its identifier, with no target
  person: the log is exempt from every purge, and an entry naming the person
  would keep, for good, which neighbour a disturbance case was about after the
  clock had removed the record. The timeline says that a person was recorded,
  never whom.
- **The access report reads it, apart from the reporter's own cases.**
  `issuesConcerningPerson` (`issue-concerned-persons.ts`) is the one where-input for "the cases concerning P
  that P did not report"; the section that carries such a case to P, and the
  board's art. 15(4) weighing of what of the reporter's words it leaves out, are a
  change of their own. Until it lands, `IssueConcernedPerson.personId` is a named
  gap under [ADR 0019](0019-every-column-that-names-a-person-is-answered-for.md),
  the fifth.

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
   15(4))_: answered on 2026-11-09. A case about a person who did not report it
   goes into that person's access report, with its number, type, dates, status,
   outcome and what it holds about them, and never the reporter's identity nor
   the reporter's words where they would identify the reporter. The board records
   the art. 15(4) weighing; the report says that something was left out, why,
   and that the person may complain to IMY, and the case is never withheld whole
   (EDPB Guidelines 01/2022, paras 168-174). Which cases are about the person is
   what a handler records ([The people an issue
   concerns](#the-people-an-issue-concerns)). Still open, for counsel: whether
   the reporter may also be withheld as the source under art. 15(1)(g), which
   art. 15(4) does not limit (para 169) and so would need a national restriction.
   Until that is answered the report names no source for these cases.
4. **The ring-fenced clock** _(legal review)_: whether Störningar may be held this
   way at all, for how long, whether a legal hold may stand on a ring-fenced
   case, and art. 10 on an allegation (decision 32). Answered; see below.
5. **The timeline** (decision 16): if it is a table of its own rather than read
   from the audit log, each person column on it needs its own answer here.
6. **A contractor's own data** _(answered by the legal review, 2026-11-09)_, a
   sole trader's name and telephone number in the contractor register, which is
   not a person in the register: on which report, and on which clock. See
   [The contractor register](#the-contractor-register).

### The legal review's answer to question 4

The owner answered the legal review on 2026-11-09. It is research, not legal
advice, and what no source settled is listed as open for counsel.

- **Störningar may be kept this way.** The sector's guidance treats a
  disturbance case as the board's legitimate interest in the duty that
  bostadsrättslagen 7 kap. 9 § gives it, kept apart from the member and
  apartment registers and read by few, which is what the ring-fence does.
- **The board sets the clock**, from 1 to 10 years after closing, 1 by
  default, apart from the other types' clock ([The clock](#the-clock)). No
  statute sets one. The bostadsrättslag sets no deadline for acting on a
  disturbance; Bostadsrätterna has the disturbance log deleted when it is no
  longer relevant and at the latest after ten years; and what a short clock
  risks is a pattern that recurs after more than a year, or a neighbour's later
  claim against the board for not acting, inside the ten-year limitation
  period. The board weighs those for its own cases.
- **A legal hold may stand on a ring-fenced case**, as today: data needed for a
  legal claim may be kept (GDPR art. 17(3)(e)). A legal hold on the issue, a
  damage case's included, or a legal hold or a restriction on its reporter,
  keeps the text past the clock until it is released.
- **Art. 10.** An allegation of a concrete crime is offence data whether or not
  it was reported to the police, so the ring-fenced form's warning asks the
  reporter to describe what happened, what they saw and heard, and when, and
  not to accuse anyone of a crime or give the details of a police report.
  Evaluative free text in disturbance cases is what Datainspektionen criticised
  in A2014/1272/DISK. Where a case does hold offence data, what an association
  can rely on is förordning (2018:219) 5 § (legal claims), not dataskyddslagen 3
  kap. 8 §, which covers authorities and archives. Whether taking in a complaint
  before the board decides to act is necessary for a legal claim under that
  section is open for counsel.

## Consequences

- `IssuePurgeService`, or a job beside it, removes the free-text layer on the
  board's clock; the website form's contact details keep their own 365 days. The
  record of processing activities' `issues` row states both, and its subjects gain
  board members, former residents and the property manager.
- The nightly issue purge takes a contractor off the list ten years after the
  last work order sent them, after the work-order texts, and the copy of whom a
  work order went to that such a contractor left behind goes with the text, by
  the work-order text purge or a handler's redaction, or with the release of the
  hold that kept it. The first work order mailed to a contractor links the association's
  privacy notice, and is not sent while the notice is unpublished
  ([The contractor register](#the-contractor-register)).
- An issue erasure job reads granted requests and runs before `53 3`.
  `ERASURE_DOMAINS` and `ErasureDomainKey` gain its domain, with the board's
  screen's words for it in both languages, and the list of domains in the
  comment over `erasure-domains.ts` names issues.
- `COLUMN_COVERAGE` gains an entry for every new column, and the `gap` list stays
  at four, but for `IssueConcernedPerson.personId`, the fifth until the access
  report's section for the cases about a person lands. `DATA_SUBJECT_REPORT_SECTIONS` gains `issueAssignments`, held to both
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

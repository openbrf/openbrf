# ADR 0054: Issue types, statuses and outcomes

Date: 2026-11-02

## Status

Accepted, with the questions under
[Open questions](#open-questions) left to the owner. The first of four records
for the issue module (ADRs 0054 to 0057). It replaces the rule the schema
states over `IssueStatus`, "Deliberately three states", and the audience on
`IssueType`. Changes the glossary rows _issue_ (ärende) and _issue type_
(ärendetyp), and adds the terms the module names (see
[The glossary](#the-glossary)).

The decisions it records were made by the owner on 2026-11-02 in the issue
module plan, and are cited here by that plan's numbers: "decision 6" is the
plan's sixth. Nothing here reaches a release before the whole module does
(decision 3): the module is built on `integration/issue-module` and lands on
`main` in one pull request.

## Context

An issue today is a type, a location, a description, photos and three
statuses. `IssueStatus` is `NEW`, `IN_PROGRESS` and `DONE`, and the schema says
why there are no more: "a status a board cannot act on is a status that goes
stale, and three is what the triage queue can actually keep true." Pull request
#42, which introduced it, put comments, assignment and contractors in a later
module. This is that module, and the rule it inherits is the one #42 stated:
**every status needs an act that keeps it true.**

An `IssueType` carries one audience, `NON_MEMBER`, `MEMBER` or `BOARD`, so a
board that wants "Vattenläcka" offered on the website and in the application
keeps two types with the same name. The status is spelled by hand in about
twelve places: the schema, `IssueService`, the controller's validation, the
action registrar, the data subject access report and its browser mirror, the
feed's issue badge, the queue panel, the overview and the English strings. The
queue is ordered by the enum's declaration order, and the public-form purge in
`issue-purge.service.ts` reads `status: "DONE"` literally.

The owner decided (decision 2) that all house matters share one queue, told
apart by type: faults, questions, complaints, and cases internal to the board
such as insurance. Subletting, motions, key orders, the contact form and the
board mailbox keep their own flows, because sublets and motions carry statutory
rules and GLOSSARY.md separates correspondence from an issue.

## Decision

### One type, with settings

A type is one row (decision 5). Besides its name, whether it is active and its
place in the order, it carries:

- **Who may report it**: any of the public website's form, signed-in residents,
  and handlers alone. A set rather than a level, so the migration below can
  merge two types without offering either to anybody it was not offered to.
- **Who handles it** (decision 13): the board only, or every handler. A case can
  be tightened to the board only on its own; it cannot be loosened past its
  type.
- **Its statuses** (below).
- **A default assignee** and **a default priority** (decisions 11 and 12).

The name stays monolingual, stored as written (decision 59 of the product
decision log). A new instance starts with a Swedish set that works without
setup, so the website's form takes reports from the first day. A type that has
been used is switched off rather than deleted, as today. The seeded set includes Störningar and an insurance type, both handled by the board
only (decision 13).

"A handler" in these records is a person holding `issues:handle` whom the type,
and the case, let in: a board member with a seat today, an administrator, and
the property manager where the type is handled by every handler. "The board
only" is enforced inside `IssueService`, on every read and every write, by the
same function for the screen, the actions, the counts, search and the mail and
reminder recipients. That is where the masking of a protected reporter already
happens, and for the same reason: a filter applied higher up is one a later
route can step past.

### Four meanings, and the board's own labels

Every status belongs to one of four fixed meanings (decision 6):

| Meaning       | Default label | What keeps it true                                                   |
| ------------- | ------------- | -------------------------------------------------------------------- |
| `NEW`         | Ny            | Reported and not yet taken up. The queue shows these first.          |
| `IN_PROGRESS` | Pågår         | Somebody is working it. The assignee is reminded when it is overdue. |
| `WAITING`     | Väntar        | It waits on a named party, with a reason (below).                    |
| `DONE`        | Klar          | It is closed, with an outcome (below).                               |

`NEW`, `IN_PROGRESS` and `DONE` are the values of today's enum, and `DONE` keeps
its name rather than becoming `CLOSED`, so an audit entry written before this
change still reads as a meaning.

The default set is the four labels in the table, one status of each meaning, and
a type works with no setup at all. A board may rename a status and add more to a
type, and each status it adds belongs to one meaning. Every type keeps at least
one status of each meaning, so a case can always be closed and always be put to
wait. One status of each meaning is the one a case enters when it moves into
that meaning without a status being named: a new report, a reopening, a reply
that ends a wait. A status that a case has stood in is switched off rather than
deleted, as a type is, so the timeline keeps saying what it was.

**Everything that decides reads the meaning and never the label.** Reminders,
the queue's order, the views (Mine, Unassigned, Overdue, All), the counts on the
board's front page, the purge and the data subject access report each ask which
meaning a case is in. The queue sorts by the meaning's order and then by the
board's order of the statuses within it, never by an enum's declaration order.
Every one of the places that spells a status today moves to read the meaning or
the status row, in the change that makes statuses data; none is left spelling a
label.

A label is the board's own text, as a type's name is. So the audit entry for a
status change carries the two meanings and the two status identifiers and never
a label, under the rule that an entry's context holds facts and never free text
(`audit-log.service.ts`).

### Waiting carries a reason

Moving a case into a `WAITING` status requires one of four reasons (decision 6):
the **reporter**, a **contractor**, **parts**, or a **decision**. The reason is
stored on the case while it waits and cleared when it leaves. A reason is a
fact, so the audit entry carries it.

The reason is what keeps the status true: it names who the case waits on, so a
handler reading the queue knows whom to chase, and a case waiting past its
target date is reminded like any other open case. A wait on a contractor is
also shown with the state of its work order. A case leaves a wait by a
handler's act; whether a reporter's reply ends a wait on the reporter by itself
is open (question 3).

### Closing carries an outcome

Moving a case into a `DONE` status requires an outcome (decision 7), one of a
fixed list:

| Outcome                       | Swedish                     |
| ----------------------------- | --------------------------- |
| `FIXED`                       | Åtgärdat                    |
| `TENANT_OWNER_RESPONSIBILITY` | Bostadsrättshavarens ansvar |
| `NO_FAULT`                    | Inget fel                   |
| `REFERRED`                    | Hänvisat                    |
| `DUPLICATE`                   | Dublett                     |

Fixed, and translated rather than written by the board, because reporting reads
it and because the second is a statement about BRL 7 kap. that a board should
not be able to reword into something else. `DUPLICATE` is what merging a case
into another writes (decision 22).

`closedAt` is written when a case moves into the `DONE` meaning from another
meaning, under `lockIssue`, as it is today, because the wrong value moves the
purge earlier. A move between two `DONE` statuses does not touch it. Leaving
`DONE` clears it and the outcome; the timeline keeps both.

A case closed before this change has no outcome, and the migration gives it
none. The outcome is null on those rows and on no other, and nothing derives one
for them, on the precedent of a transfer's report basis (GLOSSARY.md,
_övergång_): writing `FIXED` on every old closed case would be the platform
stating something nobody decided.

### Reopening

A reply from the reporter within 30 days of `closedAt` reopens the case and
alerts its assignee (decision 8). After that, the reply field offers a new
report instead, linked to the old one by a plain, nullable reference that
survives the old case being purged. A handler can reopen a case at any time by
moving it out of `DONE`.

### Priority, target date and assignee

Three fields every case carries, set by handlers and never by a reporter
(decisions 9 to 11): an **assignee**, one person holding `issues:handle` whom the
case lets in, or none; a **priority**, `URGENT`, `NORMAL` or `LOW` (Akut, Normal,
Låg); and an optional **target date**. A case is overdue when its target date
has passed and it is not `DONE`. There are no timers: the law asks for repair
"så snart det kan ske", and a clock on a volunteer could be read as a standard
the association set itself. The assignee is internal, and a reporter never sees
who it is.

### Cases a handler opens

Any handler, the property manager included, can open a case for a named resident
or as an internal case with no reporter (decision 14). The case records that a
handler entered it and which handler, and shows it. For a named resident, that
resident is the reporter, and every rule about a reporter applies to them,
masking included.

### The migration

`NEW`, `IN_PROGRESS` and `DONE` move onto the three default statuses of those
meanings on each case's type. Types with the same name, compared after trimming
and as written otherwise, merge into one whose reporters are the union of their
audiences: `NON_MEMBER` becomes the website's form, `MEMBER` signed-in
residents, `BOARD` handlers alone. Every merged type is handled by every handler,
which is what every type is today. A merged type is active if any of its
duplicates was, and takes the earliest place in the order.

### The glossary

Added before any code, as the plan requires: ansvarig (assignee), arbetsorder
(work order), entreprenör (contractor), intern anteckning (internal note), känt
fel (known fault), prioritet (priority), senast klart (target date), skadeärende
(damage case), svar (issue message) and tillträde (entry permission). _issue_
and _issue type_ change to match this record, and _overview_ no longer says that
nothing in the model assigns work to anybody.

The plan proposed _due date_ for senast klart. GLOSSARY.md already gives _due
date_ to förfallodag, the day a fee notice is to be paid, which by its own row
is "read by nothing". A target date is read by reminders and the Overdue view,
so one English word for both would put two opposite rules behind one
identifier. _target date_ is proposed instead; see
[Open questions](#open-questions).

The concepts this record names in English but gives no row yet - the four
meanings, the waiting reason, the outcome, a handler, and a case's reopening -
get their rows in the change that introduces them in code, as GLOSSARY.md asks
under "Adding terms".

## Open questions

Calls the plan does not make, left to the owner and listed on the task that
wrote this record:

1. **What a reporter sees of a status.** The board's label, which may be written
   for handlers ("Väntar på styrelsebeslut") and is monolingual, or the meaning
   in the reporter's own language. And whether a reporter sees that a case waits
   on them.
2. **Which status a reopened case enters**: the default `IN_PROGRESS` status, or
   the default `NEW` one, which puts it back among the unassigned.
3. **Whether a reporter's reply ends a wait on the reporter** by itself, or only
   alerts the assignee.
4. **An administrator without a board seat and a type handled by the board
   only.** An administrator holds every capability by derivation, while the
   apartment binder is read under a capability a seat alone confers. Which of
   the two a board-only type follows.
5. **What marks Störningar as ring-fenced** (decision 32): a setting any type may
   carry, and who may set it, or the seeded type alone.
6. **How the property manager names a resident** on a case they open (decision 14) without a register read: the product decision log's decision 11 keeps
   them out of the address book.
7. **_target date_ for senast klart**, in place of the plan's _due date_, for the
   reason above.

## Consequences

- `IssueStatus` and `IssueAudience` give way to status rows with a meaning, and
  to the type's settings. Each of the places that spells a status today moves in
  the same change, and the public-form purge reads the `DONE` meaning
  ([ADR 0057](0057-purging-issues-in-two-layers.md)).
- The property manager's role widens: they may open cases, and a board-only type
  is closed to them. `PRODUCT.md` and the comment over
  `PROPERTY_MANAGER_CAPABILITIES` say so.
- A reporter's form offers the types whose reporters include them, as today; the
  board's internal categories are still shown to nobody who does not handle
  issues.
- The AI package's triage moves from four priorities to three (decision 35), in
  its own repository.

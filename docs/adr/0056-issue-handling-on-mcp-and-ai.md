# ADR 0056: Issue handling on `mcp` and `ai`

Date: 2026-11-02

## Status

Accepted, with the questions under [Open questions](#open-questions) left to the
owner. Amends
[ADR 0040](0040-read-actions-for-issues-and-contact-messages.md): its issue reads
change shape, and its "What is not decided here" bullet on changing an issue's
status is decided here. The third of four records for the issue module (ADRs
0054 to 0057), citing that plan's decisions by number as
[ADR 0054](0054-issue-types-statuses-and-outcomes.md) does.

Rule 1 of [ADR 0008](0008-action-registry.md#what-a-person-bearing-action-must-satisfy)
binds every action named here unchanged. ADR 0040's exception to it, for
somebody the record links to no person in the register, still covers
`issue_list` and `issue_get` and nothing else: no action this record adds relies
on it.

## Context

ADR 0040 registered three reads on `mcp` and `ai`, `issue_list`, `issue_get` and
`issue_type_list`, and wrote nothing. It ended: "Another action is not covered by
analogy: it needs a decision of its own." The issue module adds an assignee, a
priority, a target date, statuses with four meanings, a conversation with the
reporter, internal notes, work orders and contractors
([ADR 0054](0054-issue-types-statuses-and-outcomes.md)), so every new read and
write needs that decision.

The owner decided (decision 34) that an MCP client may assign an issue and change
its priority, target date and status, landing at once and acting as the signed-in
person, as the news actions do. Replies to a reporter and anything sent to a
contractor stay off it by default, because those leave the instance. The `ai`
surface stays proposal-only under [ADR 0039](0039-pending-changes.md). A
ring-fenced type and every internal note never leave the instance (decision 32).

Decision 34 also asked why the issue actions do not reach the MCP Connector
today.

### Why the connector is offered no issue action

The connector is a plugin, and it lists actions through `host.actions`, on its
own route, as the person on the other end of the request. For a listing a plugin
makes, `ActionRegistryService.list` leaves out every action whose `personalData`
names a category missing from the plugin's own `personalData`, and `invoke`
refuses the same actions with `forbidden-surface` (`docs/plugin-contract.md`,
"Nor can it reach personal data it has not declared"). `issue_list` and
`issue_get` declare `name`, `apartment`, `freeText` and `health`. The
connector's manifest, version 0.1.0, declares no personal data at all.

So the plan's guess is right, and it is wider than issues: the connector is
offered no action that declares any personal data, the motion queue and the news
comments included. Nothing in the core is wrong. The connector reaches each of
these actions once its manifest declares the categories that action carries,
with a processing declaration, and the board consents to it; an action that
carries none, as two of the writes below do, is offered to it already. That
change is the connector's, in its own repository, and it is listed among the
consequences.

## Decision

### The reads

`issue_list` and `issue_get` keep their names, their capability and their
surfaces, and carry the new fields:

- the status, as its meaning and the board's label, and the waiting reason or
  the outcome where there is one;
- the priority and the target date, and whether the issue is overdue;
- the assignee, as a discriminated union over strict branches: a person with
  their identifier and name, a person whose name is withheld with their
  identifier alone (`{ kind: "protected", personId }`, as `docs/actions.md`
  publishes a protected author), or nobody;
- whether a handler entered the issue, and that the issue is closed to all but the
  board, where it is.

The withheld branch is built inside `IssueService`, by the same function that
builds the board's row, so the read stays bindable under Rule 1. Both already
declare `name`. Every `*PersonId` property they publish is held to its declared
category by the catalogue's contract test, as today.

`issue_type_list` carries each type's statuses with their meanings and labels,
its default priority and who handles it. Not its default assignee: a type's
setting naming a person is configuration, and the catalogue reads no person
today.

One new read, **`issue_handler_list`**: the people a given issue may be assigned
to, by identifier and name, with a withheld name as the branch above. A names-only
read, and its own, so an MCP client can assign without reading the address book:
the product decision log's decision 11 keeps the property manager out of it, and
the property manager holds `issues:handle`. It declares `name`.

### The writes

Four writes under `issues:handle`, offered on `mcp`, `ai` and `ui`. `ui` is
there because ADR 0039 refuses a proposal whose action is not offered on `ui`
(`forbidden-surface`), since the platform's own screens could never confirm it:
without `ui`, all four `ai` proposals would fail before reaching a person.
These are the same acts the board's screen performs, so `ui` adds no new
reach:

| Write                   | What it changes                                                  |
| ----------------------- | ---------------------------------------------------------------- |
| `issue_assign`          | The assignee, to a person `issue_handler_list` names, or nobody. |
| `issue_set_priority`    | The priority.                                                    |
| `issue_set_target_date` | The target date, or none.                                        |
| `issue_set_status`      | The status, with the waiting reason or the outcome it requires.  |

On `mcp` each lands at once, as the person who connected the app, recorded under
the audit channel `MCP`, exactly as the same act on the board's screen is
recorded under `WEB`. On `ai` each is a pending change the AI package proposes
and a person confirms on the platform's own screen (ADR 0039).

A move into a status that means DONE closes the issue, and does what closing it
on the board's screen does: it clears the resident's permission to enter and the
known fault, starts the retention clock
([ADR 0057](0057-purging-issues-in-two-layers.md)), and ends every link a
contractor holds to the issue's work orders
([ADR 0055](0055-links-for-reporters-and-contractors-without-an-account.md)).
Reopening the issue brings none of these back. `issue_set_status` lands at once on
`mcp` all the same, because decision 34 says the status does; its description
says what closing ends, so a caller deciding whether to close reads it first.

Each answers with the issue's identifier and the fields it changed, the assignee
as the branch above, and nothing else: not the reporter, the description, the
location or the conversation. That keeps the writes out of ADR 0040's exception,
which they do not need, and keeps a write from being a second way to read.

The names and the shape are this record's proposal; the change that registers
them pins them in the catalogue's contract test and in `docs/actions.md`, under
the naming rules there.

### What is never offered on `mcp` or `ai`

- **A ring-fenced type.** Its issues are left out of every read and answered as
  not found by every write, by the same omission inside `IssueService` that ADR
  0040 makes for a protected reporter: not on any page of `issue_list`, not by
  `issue_get`, not counted, and never named by a cursor. The type itself is left
  out of `issue_type_list` as well, reading decision 32's "never to ... AI or
  MCP" as it is written. The three reads ADR 0040 registered do this already:
  `IssueService` leaves a ring-fenced type's issues and the type out of every
  read it is asked for with `omit`, the argument the reads pass for a protected
  reporter. The writes this record adds, and `issue_handler_list`, answer a
  ring-fenced issue as not found by the same omission, as they answer an issue a
  reporter with protected personal data filed.
- **An issue concerning a person with protected personal data**, as a handler
  recorded it ([ADR 0057](0057-purging-issues-in-two-layers.md#the-people-an-issue-concerns)):
  left out of every read and answered as not found by every write, by the same
  omission (`omit`), because a case about such a person is about their
  household whoever reported it. Whom an issue concerns is itself on no read or
  write.
- **An internal note**, read or written.
- **The resident's permission to enter** (decision 29), **the common-area place**
  of an issue (decision 30) and **the mark of an inspection finding with its
  protocol** (decision 31), read or written. The first is the resident's answer
  about their home, kept only until the issue closes; the other two are
  not offered either until a decision of their own offers them.
- **A reply to a reporter**, and **anything that reaches a contractor**: issuing a
  work order, sending it, issuing or revoking its link. Each leaves the instance
  or reaches a person, and decision 34 keeps them on the board's screen. Closing
  an issue ends its links as a consequence of the closing, as it does on the
  screen, and no action offers that end on its own.
- **An issue closed to all but the board** is offered to a board member and never to
  a property manager, on these surfaces as on the screen.

### What is not decided here, and not offered

No action reads the conversation with a reporter, and none opens an issue, moves
an issue to another type, merges two issues, redacts text, removes a photograph
or publishes a known fault. Each would need a decision of its own; none relies
on this record by analogy.

## Open questions

Calls the plan does not make, left to the owner and listed on the task that
wrote this record:

1. **Reading the conversation on `mcp` and `ai`.** Triage would read better with
   it. The messages of a reporter linked to no person would rest on ADR 0040's
   exception, and those of a reporter the register holds on Rule 1 as stated.
   This record offers no read of it.
2. **"At once" in decision 34.** Read here as landing directly, without a pending
   change, on `mcp`. If it meant one call setting several fields, the four writes
   become one.

## Consequences

- The catalogue's contract test pins five more actions, and the exact list of
  actions offered on `ai` grows by the four writes and `issue_handler_list`.
- The MCP Connector is offered each of these actions only once its manifest
  declares the personal data that action carries and the board consents; until
  then it is offered no person-bearing action at all, and of these only
  `issue_set_priority` and `issue_set_target_date`, which carry none. A change to the connector, in its own repository.
- The AI package's triage reads the three priorities and the new fields, and its
  dependencies on `issue.type` and `reporter.personId` in the published output are
  checked (decision 35), in its own repository.
- ADR 0040's "Changing an issue's status or type" bullet is answered for status
  and left open for type.

# ADR 0040: Read actions for issues and contact messages

Date: 2026-10-20

## Status

Accepted. Amends [ADR 0008](0008-action-registry.md): Rule 1, the exposure
rule, gets one scoped exception, for what somebody linked to no person in the
register writes (see
[An exception to Rule 1](#an-exception-to-rule-1-for-somebody-linked-to-no-person)).
Its context comes from gap G5 in
[the AI package gap audit](../ai-package-gap-audit.md#g5-permissions-and-core-actions).

## Context

Issue triage in the AI package reads issues and suggests how to handle them.
There was no action to read an issue or a contact form message with. The core
registered actions for news, comments, the website, the association facts and
motions only. The capabilities that would gate the new actions exist:

- issues are handled under `issues:handle`
  (`apps/api/src/authorization/capabilities.ts:83`);
- contact form messages are read under `signupRequest:decide`
  (`apps/api/src/contact/contact.controller.ts:40-55`).

Both hold text residents and visitors wrote. GLOSSARY.md calls an issue "among
the most sensitive free text the platform holds - a report about a leak or a
neighbour carries health data and a third party's details without anybody
intending it". A contact form message comes from somebody without an account.

Some constraints were already fixed:

- Each description says that the text it returns was written by people and is
  data, never instructions (`docs/actions.md`, "What a description must say").
  For these actions that sentence is the main defence, because the text comes
  from outside the board.
- An action returns only what the calling person could read on their own
  screen. Nothing is stored by reading.
- An action declaring `protected` is refused on `mcp` and `ai`
  (`apps/api/src/actions/action-registry.service.ts`, `register`), and an action
  may bind a read only where the masking or the omission happens inside the
  service method it calls (`docs/actions.md`, "What an action that names a
  person must satisfy").
- Sending the text to a model provider is the plugin's processing. The board
  classifies that recipient on the consent screen
  (`docs/plugin-contract.md`).

## Decision

Three read actions, registered by the core. Nothing here writes.

| Action                 | Capability             | Surfaces    | Personal data                             |
| ---------------------- | ---------------------- | ----------- | ----------------------------------------- |
| `issue_list`           | `issues:handle`        | `mcp`, `ai` | `name`, `apartment`, `freeText`, `health` |
| `issue_get`            | `issues:handle`        | `mcp`, `ai` | `name`, `apartment`, `freeText`, `health` |
| `contact_message_list` | `signupRequest:decide` | `mcp`, `ai` | `name`, `freeText`                        |

### On `mcp` and `ai`, and not on `ui`

The board's own screens read the queue and the inbox through their own routes,
so an in-process action would be a second way to the same rows with nobody
asking for it. These are core actions, so nobody arms them: adding the surface
is the decision ([ADR 0038](0038-the-ai-channel-for-a-plugin-s-dispatch.md)).
A plugin that declares itself an AI package reaches them on the `ai` channel
that ADR 0038 gives its dispatch.

### One rule for what is visible, the screen's

Both issue actions read through `IssueService`, which also serves the board's
screen: the same query, the same order and the same function building a row.
Each capability reads exactly what its holder reads on the screen:

- All three audiences of issue type, the board's internal ones included.
- The property manager reads what the board reads. `issues:handle` is their
  one capability besides their own account (decision 11).

`issue_list` filters on status, type and audience, and pages with a cursor, as
`motion_queue_list` does: at most twenty issues a call, and a `nextCursor`
naming the place in the order rather than a row. `issue_get` reads one issue.
Both return its type with its audience, its status, location, description and
apartment, its reporter, the dates it was created, last changed and closed,
and how many photographs it carries. The photographs themselves stay on the
board's screen: a photograph of a stairwell may show a neighbour, and a caller
outside the instance has no use for a path it cannot open.

### A protected reporter's issue is left out altogether

An issue a reporter with protected personal data filed is in neither action's
answer: not on any page of `issue_list` under any filter, and `issue_get`
answers its identifier exactly as an identifier that does not exist, with the
same reason and the same sentence. Beslutslogg 64 puts protected personal data
outside every token and every prompt. Withholding the reporter's name and
apartment, as the screen does, would still hand the model a report about the
reporter's own home.

The omission is made inside `IssueService`, by an argument each queue read is
called with (`ProtectedReporters`: `show` or `omit`). The screen shows; the
actions omit. That, with the exception below for an issue whose reporter is
linked to no person, is what lets the actions declare `name`, `apartment`,
`freeText` and `health` without declaring `protected`, which would keep them
off `mcp` and `ai` altogether. The issues are left out of the query, so a page
is not short for them, and again once the reporters are read, so a person
whose data became protected between the two reads is not shown either. A page
that loses a row that late reads on until it is full again, and `nextCursor`
names the last issue on the page, never a row that was dropped: a cursor is
the issue's status, the instant it was filed and its identifier, and handing
that over would be a trace of it.

The descriptions say in general terms that some reports are handled only on
the board's own screen, so a caller is not told there is nothing it cannot
see. An integration test reads the whole queue under every filter, on `mcp`
and through the handler the `ai` surface reaches, and asserts that no trace of
such an issue appears: not its identifier, its text, its location, its
apartment or its reporter.

### Reporters, and the address nobody is given

A reporter arrives in one of three shapes: a resident with their name, an
external reporter from the website's form with the name they gave, or unknown.
An external reporter's email address is not given, and neither is a contact
form sender's: the board answers both from its own screen.

### Contact messages

`contact_message_list` reads the inbox a page at a time, unhandled first, with
the sender's name, the message, whether it is handled and when it arrived, and
the counts of unhandled and all messages.

It declares `name` and `freeText` and not `protected`, and it stays on `mcp`
and `ai`. That does not satisfy Rule 1 of ADR 0008: it rests on the exception
the next section makes to it.

### An exception to Rule 1 for somebody linked to no person

Rule 1 of
[ADR 0008](0008-action-registry.md#what-a-person-bearing-action-must-satisfy)
says that an action which can return a field of a person carrying protected
personal data declares `protected`, which keeps it off `mcp` and `ai`, and that
an action may bind a read only where the masking or the omission happens inside
the service method its handler calls. It makes no exception for a service that
cannot tell who a person is.

`contact_message_list` can return such a field. The sender writes without an
account, and a message is linked to no person in the register: a
`ContactSubmission` records no person for its sender. Protected personal data
is a mark on a person in the register, so the platform does not know whether a
sender has it, and `ContactService` has no field to mask and no row to omit. A
sender with protected personal data who signs a message with their name, or
writes where they live, has put that in the inbox, and this action hands it to
a connected app or the AI package with the rest of the message, as it would
any sender's. An issue with no reporter in the register stands where a contact
message does. `IssueService` leaves out the issues of reporters marked as
having protected personal data, and keeps every issue whose `reporterPersonId`
is empty, such as an external reporter's from the website's form, because
there is no person to look up.

Read as written, Rule 1 would have all three actions declare `protected` and
be offered nowhere worth offering them. This ADR amends it instead, with one
exception and no more:

- **What it covers.** A field written by, or about, somebody the record links
  to no person in the register: the sender's name and the message of a
  contact message, and the reporter's name and everything else an issue with
  no reporter in the register says. An action relying on it declares `name` and
  `freeText` as usual and not `protected`.
- **What it does not cover.** A person the register holds. Wherever the
  service can tell that a person has protected personal data, Rule 1 binds
  unchanged, and the masking or the omission happens inside the service, as
  `IssueService` does for a protected reporter. Nor does it cover a sender's
  or an external reporter's email address, which neither kind of action
  returns.
- **What it accepts.** A sender or an external reporter with protected
  personal data can be named to a connected app or the AI package by what
  they wrote themselves. The platform cannot see that case and cannot narrow
  it, and keeping the inbox and every external report out of triage is the
  only way to rule it out.
- **Who may rely on it.** These three actions. Another action is not covered
  by analogy: it needs a decision of its own that amends ADR 0008 again.

Matching the sender's address against the register was considered and not
adopted. Nobody confirms the address typed into an anonymous form, and one
address can belong to a whole household, so a match says what somebody typed
and not who wrote.

### What is not decided here

- **The board mailbox** (`boardMailbox:handle`) is out of scope. A letter is
  untrusted input from outside the association and gets a decision of its own.
- **A suggested reply** is not stored anywhere. If the AI package drafts one,
  the board reads it in the package and writes its own reply.
- **Changing an issue's status or type** is a write, and is decided with the
  other writes the AI package needs.

## Consequences

- Issue triage can read the queue for the board member or property manager who
  asked, as that person, and sees what they would see on the screen less the
  reports of people with protected personal data.
- A board member who asks a model about a protected reporter's issue gets
  nothing back, and the description tells the model that some reports are
  handled only on the board's screen. The board handles those reports there.
- Rule 1 of ADR 0008 carries one exception, for somebody linked to no person
  in the register. ADR 0008, `docs/actions.md` and the personal-data category
  in GLOSSARY.md point here for it, and a sender or an external reporter with
  protected personal data can reach a model through what they wrote
  themselves.
- `IssueService` reads the queue a page at a time for the actions. The board's
  screen still reads it whole; paging it is a change of its own.
- `ISSUE_ACTION_ERRORS` publishes the one refusal the reads can raise,
  `issue-not-found`, rather than every reason `IssueError` declares: the
  others belong to filing a report, the photographs and the type catalogue.
  `CONTACT_ACTION_ERRORS` publishes `unknown-cursor` alone, a reason of its
  own for a cursor the inbox did not hand out rather than `not-found`, which
  belongs to marking and removing a message. Both sentences are under
  `actions.errors`, because the screens' own say that the list has been read
  again, which a read action does not do.
- Both `after` inputs publish the cursor's shape as a pattern, so the document
  a caller reads refuses what the action refuses as far as JSON Schema can say.
- The catalogue contract test pins exactly these three actions as the ones
  offered on `ai`, so a later action joins that list only by a decision of its
  own.

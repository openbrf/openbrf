# ADR 0039: Pending changes

Date: 2026-10-19

## Status

Accepted, with the change that builds it. Its context comes from gap G4 in
[the AI package gap audit](../ai-package-gap-audit.md#g4-holding-a-change-for-preview-and-confirmation).
Amends [ADR 0008](0008-action-registry.md), "Writes land directly, and are
attributable": a write on the `ai` channel no longer lands directly.

## Context

ROADMAP.md promises that with the AI package "a board member describes a change,
sees it as a preview and confirms it before anything is written"
(`ROADMAP.md:1302-1309`). Nothing in the core can hold a change until then:

- `needsConfirmation` is on every action "so a pending-changes queue could be
  added later without changing a plugin. There is none today - writes land
  directly" (`docs/actions.md:251-253`;
  `docs/adr/0008-action-registry.md:380-384`).
- The registry's only rule about the flag is that a delete must declare it
  (`apps/api/src/actions/action-registry.service.ts:173-182`).

The plugin cannot hold the proposal itself. It has no state it can write
(`packages/plugin-sdk/src/host.ts:45-52`). The store proposed in draft ADR 0033
(#404) is for configuration and never for people, and a proposed page or news
item can name a resident. Every column that names a person has to be answered
for by the data subject access report and by purging
([ADR 0019](0019-every-column-that-names-a-person-is-answered-for.md)), so the
proposal belongs in the core.

One case is already covered. A news mailing is "confirmed as a mailing in its
own right", and that is the mailing request: `news_request_mailing`, which a
board member answers in the web interface
(`apps/api/src/news/news-actions.registrar.ts:580`; GLOSSARY.md, "begäran om
nyhetsutskick").

## Questions the decision had to answer

1. **What a pending change is**, and the term GLOSSARY.md gives it. It holds:
   - the action and its input;
   - who proposed it, and on which channel;
   - what it was proposed against, such as a page's revision, so a stale
     proposal is refused rather than applied over newer work;
   - its state: proposed, confirmed, rejected or expired;
   - when it expires.
2. **Which calls it holds.** Every write on `ai`? Only actions with
   `needsConfirmation`? Does `mcp` use it, or do MCP clients keep asking on their
   own side, as ADR 0008 assumes today?
3. **Who may confirm.** Is it the person who proposed, or anyone holding the
   action's capability? The capability is checked again at the moment of
   confirming, as the registry checks it on every call.
4. **What is recorded.** Is the confirmed write the confirming person's, on
   `web`, or the proposer's, on `ai`? Proposing and rejecting are acts of their
   own in the audit log.
5. **The preview.** Is it one generic rendering of the input, or a preview each
   action declares, such as the page as it would look? It follows DESIGN.md.
6. **Retention.** A pending change is service tier. When is it purged after it
   is decided or expires, and which section of the data subject access report
   carries it?

## Constraints already fixed

- The registry stays the one place a change is dispatched
  ([ADR 0008](0008-action-registry.md)). Confirming dispatches the held action
  through `invoke`, with every check made again. Nothing writes around the
  registry.
- A pending change holds nothing the held action could not write, and what the
  action's own input schema refuses is refused when the change is proposed, not
  first when it is confirmed. So is a personal identity number in any text of
  the input, unless the action declares `personalIdentityNumber`: the core
  services refuse one in free text, so for a core action the queue does not keep
  what the action would not write. A plugin's handler need not refuse one; for a
  plugin action the declaration is the rule.
- No action touching protected personal data is held on `mcp` or `ai`. The
  registry already refuses to offer such an action there
  (`apps/api/src/actions/action-registry.service.ts:185-207`), so a change
  proposed on those channels cannot name one. Such an action is allowed in
  process, on the platform's own screens. Whether a pending change may be
  proposed there is part of question 2. If it may, the decision has to say how
  protected personal data is refused when the change is proposed.

## Decision

### 1. A pending change is one call, held

A **pending change** is one call to an action - its canonical
name and its input as the action's own schema parsed it - held without running,
with who it was proposed as, on which channel and through which connected app,
when, and when it lapses. GLOSSARY.md gives the term.

It has no state column. A row exists only while the change waits: confirming and
rejecting delete it in the transaction that writes the audit entry for the act,
and one whose week has run out is deleted by the nightly purge. Proposed,
confirmed, rejected and expired are four audit actions, `PENDING_CHANGE_*`, and
that is where the history is. A row that outlived its decision would be a second
copy of an input that can name a resident, kept for nothing the log does not
already answer.

What a proposal was made against is carried in its input, where the action
takes one: `page_update` requires `expectedRevision`, so a page edited after the
proposal refuses it with `page-changed` when it is confirmed, rather than being
written over. The queue adds no precondition of its own; one it invented would be
a second opinion about staleness that every action would have to agree with.

### 2. Which calls it holds

**Every write on `ai`, and only on request elsewhere.** `invoke()` refuses a
write on the `ai` channel with `confirmation-required`, a reason the vocabulary
already reserved, before the capability is read; the remedy is to propose it.
The rule does not read `needsConfirmation`, because a model rewriting a page
needs a person's eye as much as one deleting it, and the flag stays the hint for
a client it was.

Proposing is open to any caller the registry can resolve, through
`ActionRegistryService.check()`: a plugin's own route does it today through
`host.actions.propose`, and the AI package will once ADR 0038 derives its
channel. `mcp` is not held. An MCP client asks its own person before a write
tool, as ADR 0008 assumed, and a connector that wanted to hold changes would
propose them the same way.

`check()` is every step of `invoke()` before the handler, and the two share one
private method so they cannot drift: the action exists and is offered on the
proposer's channel, a plugin's is serving and armed, the token's scope, the
capability, the plugin's floor, the input. Two refusals are a proposal's own,
both `forbidden-surface`: a read, which has nothing to confirm, and an action
not offered on `ui`, which the platform's screens could never confirm.

Protected personal data needs nothing new. An action declaring `protected` is
refused `mcp` and `ai` at registration, so nothing proposed on those channels can
name one. One proposed in process, on `plugin`, is held to the same capability
the action declares and shown only to the person who could have made the call
directly; the queue widens nobody's view.

### 3. Who may confirm

**The proposer, and nobody else, in the web interface.** Every read and act is
keyed on the person as well as the id, and a change somebody else proposed
answers `pending-change-not-found`, as one that never existed does. A pending
change is the proposer's own: it may hold what only they asked for, and an action may be
about themselves, so a colleague holding the same capability confirming it would
run it as the colleague on input the colleague never chose.

Confirming dispatches the held call through `invokeHeld()` with a caller minted
by `ActionCallerFactory.forConfirmation`: the confirming person, on `web`, at
that moment. Every check is made again, so a board term that ended, an action an
administrator disarmed or a plugin switched off in between refuses it then.
`forConfirmation` refuses a request that carries a token, and the routes take the
session cookie only because the global guard answers a token on no route but the
connector's.

The arming is asked about on the channel the change was proposed on, not only on
`web`. On the `ui` surface a serving plugin's action needs no arming, so a change
an app or a model proposed while the action was armed would otherwise still run
after an administrator disarmed it. `forConfirmation` carries the proposal's
channel, and the registry refuses the confirmation `forbidden-surface` unless the
action is still offered there: on that surface and, for a plugin's, armed. A
change a plugin's own route proposed needs no arming, as the route needed none.

**Nothing runs twice.** The action's service writes in its own transaction, which
the queue cannot enlist, so the change is not consumed together with the write: it
is claimed before it. `invokeHeld()` is `invoke()` with one step between the last
check and the handler, where the queue stamps `dispatchedAt` on the row if it is
still waiting, in a write that commits at once. From then on the change is not
waiting - it is not listed, cannot be confirmed again and cannot be rejected - so
a second press, or a retry after a confirmation that failed on the way back,
finds nothing to run. What follows depends on the answer:

- A refusal at a check comes before the claim, and the change waits untouched.
- A refusal raised by the action's own service wrote nothing, because a service
  refuses before it writes or rolls its write back. The claim is lifted and the
  change waits again, to be confirmed once the refusal no longer holds, or
  rejected.
- Anything else ends the change, success or not: `internal` may come after the
  service's transaction committed, and `output-invalid` always does.
  `PENDING_CHANGE_CONFIRMED` records the reason the action failed with under
  `failure`, and the write's own entry, if it stands, names the pending change.
  The person is answered `pending-change-failed-after-dispatch` rather than the
  action's reason, and the screen says the change may have taken effect and is
  no longer waiting, reads the queue again, and does not offer it again.
- A plugin's action that invokes another through `host.actions.invoke` receives
  that call's `internal` or `output-invalid` as a refusal of kind `registry`.
  Handed on, as it is or as the `cause` of a refusal of the plugin's own, it
  ends the change as the inner failure would, and `failure` records the inner
  reason. The inner call is the plugin's own, so its write's entry does not
  name the pending change; `PENDING_CHANGE_CONFIRMED` does.

If the confirmation cannot even record itself, the row stays claimed and unseen,
never to run again, and the nightly purge deletes it at its expiry with
`PENDING_CHANGE_EXPIRED` saying `dispatched`. The person is answered
`pending-change-failed-after-dispatch` here too, since the action ran. Losing a change that was claimed and
then failed is the side to fail on: it can be proposed again, and it cannot run
twice. The integration suite fails the confirmation's own audit entry after the
action wrote, and has the action return what its schema refuses, to show it.

Widening this to the board - any holder of the action's capability confirming
somebody else's proposal - is a later decision. It would need an answer for
self-scoped actions and for whose input is being run, and narrowing it again
after a release would break whoever relied on it.

### 4. What is recorded

- `PENDING_CHANGE_PROPOSED`: the proposer as actor, on the channel and with the
  connected app the proposal came through; the target is the pending change.
- `PENDING_CHANGE_CONFIRMED` and `PENDING_CHANGE_REJECTED`: the proposer as
  actor, on `WEB`. A confirmation whose action failed after it was dispatched
  adds `failure`, the reason it failed with.
- `PENDING_CHANGE_EXPIRED`: no actor, `SYSTEM`, the proposer as target person;
  `dispatched` on one a confirmation claimed and could not record (§3).

Each names the action in its context and never carries the input. The confirmed
write itself is the confirming person's, on `WEB`, written by the action's own
service in its own transaction as every write is. Its entry carries the pending
change's id under the reserved context key `pendingChange`, merged by
`AuditLogService.record` the way `client` is, from `ActorContext.pendingChangeId`
that `actorOf` takes from the caller. No service knows pending changes exist: a
service that spreads `auditActor(actor)` names the proposal without a line of its
own. So the write says who did it and how, and its `pendingChange` leads to the
proposal entry that says which channel and which app suggested it.

### 5. The preview

**Generic for now.** The screen at `/app/pending-changes` shows the action's title and
description in the reader's language and the input exactly as it will be sent,
field by field, every value as text - nothing summarised, nothing left out,
because what the screen does not show is what the person confirms unseen. Field
names are the action's own, in the data face. A preview each action declares,
such as the page as it would look, is a later addition beside the generic one;
the generic one stays, because it is the only preview that cannot disagree with
what is sent.

The first such preview is for `meeting_set_agenda`, whose input names the meeting
and its items only by id. The screen reads the meeting as the meetings screen does
and shows its kind and day, the agenda it has now beside the proposed one, and the
items the proposal removes (matched by title, since the write replaces the whole
list). It says when the agenda has changed since the proposal, which the write
would refuse with `agenda-changed`. The meeting is read again each time the queue
is, after a change on the screen was answered, and when confirming this one is
refused, so a second proposal for the same meeting is shown beside the agenda the
first one left rather than the one it replaced. It sits above the generic
preview, which is unchanged, and `expectedItemIds` stays required in the action's
schema.

A plugin links the person to the change with the `path` that `propose` answers
with. The screen has no entry in the navigation until something proposes
changes routinely: an always-empty destination is a defect by the navigation's
own rule. A refusal on confirm shows the sentence the action published for that
reason, the one the board's own screens use.

### 6. Retention

A pending change waits seven days. Past `expiresAt` it can be neither seen nor
confirmed, whether or not anything has swept it. The claim holds a confirmation
to the expiry at the moment it is made, not when the button was pressed, so a
change that lapses while the registry's checks run does not run. The service-data purge deletes
expired changes the following night, one proposer at a time under the legal hold
key, and leaves those of a person under a legal hold or a restriction until it is
lifted - the session sweep's rule, for the same reason. A person's own purge
deletes every change they proposed, since nobody else could confirm one.

The access report carries pending changes through the audit log, as the acts of
the person who proposed them (`actedAs` in `data-subject-report-coverage.spec.ts`).
There is no section of their own: a change can be read for a week at most, and its
input is the person's own pending change, which they can read on the screen until it ends.

**Somebody else named in the input.** An input can name a person other than the
proposer: in free text, such as a news item's body or a page's text, in a
photograph a page block shows, or in whatever a plugin's action declares it
handles. No core write action takes a person's identifier in its input. The
queue does not look for such people. It cannot tell which field of an action's
own schema names someone, and it does not parse prose for names, which is the
rule the purge already keeps for an issue's description. So while a change
waits, it is on no report of the person it names, and their purge does not
delete it.

What bounds this is the week, and then the purge. A change ends by
confirmation, rejection or expiry. A confirmed change becomes the action's own
record, which the rules for that record cover from then on, as if the confirming
person had written it on the screen. A rejected change is deleted at once. An
expired one is invisible and cannot be confirmed from the moment it expires, and
the nightly purge deletes it the night after. A rejected or expired change
leaves only the audit entries, which carry no input. So an input that names
somebody can be seen and confirmed for at most seven days, by the proposer
alone, and the row is gone the night after it expires.

That bound holds unless the proposer is under a legal hold or a restriction.
The purge leaves their changes until the hold is released or the restriction
lifted (§6 above), so a change that names a third person can outlive the month
art. 12(3) allows for an answer to that person's art. 17 request. This is
accepted. The hold or the restriction is itself the board's decision to keep
what that person's records hold, the pending change among them, and art. 17(3)(e)
and art. 18 allow keeping data for that reason. Meanwhile the change cannot be
seen, confirmed or acted on by anyone, and it goes on the first night after the
hold ends. The queue cannot find a change by the person it names, so the board
does not look for one when it grants an erasure. A board that knows of a held
change that names the person erased decides then whether the hold's basis covers
that change, and no mechanism for that is built here. Outside a hold or a
restriction, an erasure the board grants for the named person needs nothing done
to the queue.

The cost is art. 15. A person who downloads their access report while a change
naming them waits is not shown that change, so the copy art. 15(3) promises is
incomplete for up to a week. This is accepted for three reasons. The change
holds nothing the action would not write. What it writes is found the same way
the action's own record is. And a search for people in every input would be a
parser of free text, which the platform has nowhere else. An action that needs
a person's identifier in its input is the case this does not cover, because an
identifier can be searched. Before a core action takes one, this decision must
say how the person's report finds a change that names them and how their purge
removes it.

## Consequences

- `host.actions` has a new member, `propose`, and `ActionContext` a new optional
  field, `pendingChangeId`. Both are additive; the plugin API version stays 1, and
  a plugin feature-detects `propose` as it does `host.actions`.
- `ActionRegistryService.invoke()` is now a thin wrapper around the shared checks,
  the handler and the output validation. The order of the checks is unchanged.
- Until ADR 0038 mints the `ai` channel, the refusal in `invoke()` has no caller to
  refuse. It is tested with a planted caller so that the day the channel is
  minted, a model's write is already held.
- A confirmation holds no lock while the held action runs. The claim is one
  conditional update, committed before the handler, so a slow action costs a
  connection of its own and nothing else.
- An action's own refusal is taken to mean that it wrote nothing, which is how
  a service raises one: before the write, or inside the transaction the refusal
  rolls back. A plugin's handler is held to the same rule
  (`docs/plugin-contract.md`), because a refused confirmation waits to be
  confirmed again.

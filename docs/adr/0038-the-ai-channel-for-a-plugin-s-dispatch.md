# ADR 0038: The AI channel for a plugin's dispatch

Date: 2026-10-19

## Status

Accepted. Amends [ADR 0008](0008-action-registry.md): a plugin's dispatch is no
longer always `plugin` on the `ui` surface. Its context comes from gaps G3 and
G10 in
[the AI package gap audit](../ai-package-gap-audit.md#g3-the-channel-a-plugins-dispatch-is-recorded-on).
Questions 4 and 6 below were left to changes of their own when this was
accepted, and both were answered on 2026-10-20 (see
[Naming the plugin on the entry](#naming-the-plugin-on-the-entry) and
[Schemas in process](#schemas-in-process)).

## Context

The audit channel records which way a change reached the association's records,
and it has an `AI` value. The value is "anticipatory: no such package exists
yet" (`apps/api/prisma/schema.prisma:2094-2111`). Nothing mints it.

The channel is derived from how a request arrived and is never passed in: a
session is `web`, a token is `mcp` (`apps/api/src/actions/action-caller.ts:62-84`).
A plugin dispatching from its own route turns `web` into `plugin` and keeps a
token's `mcp` (`:104-122`). The channel then decides the surface: `plugin` maps
to `ui` (`apps/api/src/actions/action-registry.service.ts:97-103`), and on `ui` a
plugin's action needs no arming (`:810-812`).

If an AI package were written today and dispatched from its own route, the
channel depends on how the request reached that route:

- **A board member's session.** It is recorded as `PLUGIN` and reaches the `ui`
  surface. That is every core action offered in the product, and every other
  plugin's `ui` action, armed or not. It never meets the `ai` surface or the
  arming that decides what an AI package may reach.
- **A connected app's token.** It stays `mcp`, so it meets the `mcp` surface and
  its arming. The records do not show that an AI package was in between.

No core action is offered on `ai`. Each of the five registrars leaves it out on
purpose, as a decision for later (for example
`apps/api/src/news/news-actions.registrar.ts:71-73`). The broker package's gap
audit (#407, G1) found the same breadth from another side: nothing limits which
core actions a plugin dispatches.

Separately, `host.actions.list` gives a plugin no input or output schema
(`packages/plugin-sdk/src/actions.ts:184-213`). Only the HTTP catalogue does
(`apps/api/src/actions/action-catalogue.controller.ts:78-121`). The MCP
Connector needs the schemas for `tools/list`, and the AI package needs them to
describe each tool to a model.

## Questions the decision answers

1. **How the host knows a dispatch is the AI package's.** A reserved plugin id,
   as `mcp-connector` is for the protected resource
   (`apps/api/src/auth/protected-resource.ts:28`,
   `apps/api/src/plugins/plugin.errors.ts:100-108`)? Or a manifest declaration
   the board consents to and the consent screen shows? Either way the host
   derives the channel. A caller never chooses it per call.
2. **What `ai` reaches.** Does the `ai` channel map to the `ai` surface, with
   arming applying to plugin actions as it does on `mcp`? What does a token
   request on that plugin's route record: `mcp`, because the connected app is
   what reached the records?
3. **Which core actions are offered on `ai`, and by what review.** Is it added
   per action group, with the descriptions' rule that stored text is data
   (`docs/actions.md:104-125`) checked again for a model as the reader?
4. **What the audit entry names.** A connected app is named on its entries. Does
   an `ai` entry name the plugin that dispatched? Decided: yes, and a `plugin`
   entry too (see below).
5. **Other plugins.** Does the rest of the plugin dispatch stay on `plugin`/`ui`,
   or does this ADR also take #407's declared dispatch, so that no plugin
   reaches a core action it did not declare?
6. **Schemas in process.** Does `host.actions` gain each action's input and
   output JSON Schema, filtered exactly as `list` is, so a plugin can describe a
   tool it can call and nothing else?

## Constraints already fixed

- The caller is a handle only the core can mint
  (`apps/api/src/actions/action-caller.ts:7-20`). A plugin cannot name a person
  or a channel.
- A plugin dispatches only on behalf of the request its route is serving
  (`apps/api/src/plugins/plugin-host.ts:413-452`). The AI package therefore acts
  only for a signed-in person, never from a background job.
- An action touching protected personal data is never on `ai`
  (`apps/api/src/actions/action-registry.service.ts:185-207`).
- The audit log is append-only. Entries already written as `PLUGIN` stay so.

## Decision

### A plugin declares that it is an AI package, and the board consents to it

The manifest gains one field, `ai`, a yes or a no that defaults to no. A plugin
that declares `ai: true` says that a language model chooses the actions it
dispatches, for the person whose request its route is serving.

The declaration travels the way `oauthProtectedResource` does. The catalog entry
repeats it, so the consent screen states it before anything is downloaded: a
language model chooses what the plugin does, acting as the person who asked it;
it can do only what is offered to the AI package, and a plugin's action only
once an administrator has switched it on; what it changes is recorded in the
audit log as made through the AI package. The command-line install prints the
same three sentences. The install echo compares it in both directions, so an
entry that gained or lost it between the screen and the confirmation is refused
as a consent mismatch.

Unlike the protected resource, it is also recorded with the consent
(`installed_plugin.consentedAi`) and held to it at every boot. A package whose
manifest says otherwise than the board consented to, either way round, is
refused with the finding `ai-changed`. The two directions are two different
consents nobody gave. A package that came to declare it would have its writes
recorded as the AI package's on a consent that never said a model was choosing
them. One that stopped declaring it would dispatch as a plain plugin and reach
every action offered on this instance's own screens.

A reserved plugin id was the alternative, as `mcp-connector` is for the
protected resource. It was rejected for three reasons. An id is what a plugin is
called, not what it does. A reserved id would make one product's name part of
the contract, so an AI package written by somebody else could not be one. And
nothing on the consent screen would tell a board what the id implies.

### The host derives the channel, and nothing a plugin passes names one

`ActionCallerFactory.forPlugin` takes the request and what the host knows about
the plugin, and nothing else. The host reads the declaration from the manifest
held in the plugin's own host context, which the plugin's code never wrote, once,
when the host object is built. `host.actions.list` and `host.actions.invoke`
take a request, a name, an input and a filter, and none of them can move the
dispatch onto another channel. The handle the factory mints is fixed from then
on, as every caller handle is.

How the request arrived is not read off the request either. A plugin's route is
handed the real request, and `request.principal` and `request.token` are
properties it can write: adding a token to a session request would otherwise
move an AI package's dispatch onto `mcp`, past the `ai` surface, recorded as a
connected app that never called. The guard keeps a frozen copy of what it
established - the person, the token's client and scopes, the request's id - in
the map that marks the request as authenticated, and the caller factory reads
that copy and nothing on the request.

| The request on the plugin's route | A plugin                   | An AI package            |
| --------------------------------- | -------------------------- | ------------------------ |
| A signed-in session               | `plugin`, the `ui` surface | `ai`, the `ai` surface   |
| A connected app's token           | `mcp`, the `mcp` surface   | `mcp`, the `mcp` surface |

A plugin can therefore only narrow its own channel, never widen it: it can be
recorded as the AI package and reach less, but it cannot be recorded as the web
interface, a connected app or the system.

### What `ai` reaches

The `ai` channel maps to the `ai` surface, which it already did. Two things
follow from the registry as it stands, and both are now intended.

- A core action is reached only if it lists `ai` among its surfaces.
- A plugin's action is reached only once an administrator has armed it, as on
  `mcp`. That includes the AI package's own actions. The model chooses the act
  in process, so being in process is no reason to skip the arming that decides
  what a model may reach.

A program may not choose the surface it lists, and the AI package is one: a
listing asked for `ui` or `mcp` is answered with the `ai` surface.

A connected app's token on an AI package's route keeps `mcp`. The connected app
is what reached the records, its scopes and the `mcp` arming are what the call
is decided on, and the entry names the app.

### No core action is offered on `ai` yet, and each is added by its own review

This change offers nothing new on `ai`. Until a core action lists it, an AI
package reaches no core action at all. That is the narrowing at work, and it is
the right starting point.

`ai` is added per action group, by the change that needs that group: the news
and website actions for editing the site from a prompt, and the read actions of
ADR 0040 and ADR 0041 for triage and the document assistant. Each such change
checks the group's descriptions again with a model as the reader, under the rule
that stored text is data and never an instruction (`docs/actions.md`), and
states why each action in the group may be chosen by a model. An action
touching protected personal data can still never list `ai`.

### Other plugins stay where they are

A plugin that does not declare `ai` keeps `plugin` and the `ui` surface. Which
core actions such a plugin may reach is the question of the broker package's
declared dispatch (#407, its G1). It is a decision about every plugin, not about
the AI package, and it is not taken here.

### Left to their own changes

- **Question 4, naming the plugin on the entry.** Left open when this was
  accepted, because naming the plugin is a column on the audit log and a line on
  the data subject access report, for both channels at once. Which plugins the
  board consented to as AI packages, and when, is in the install record and its
  audit entries: the `PLUGIN_INSTALLED` entry carries the same `ai` the row
  records, and keeps it when a reinstall rewrites the row or an uninstall
  deletes it. Answered below.
- **Question 6, schemas in process.** Left open when this was accepted, because
  the answer belonged with the MCP Connector, which needs it first. Answered
  below.

### Naming the plugin on the entry

_Amended 2026-10-20._ Every audit entry that a plugin's in-process dispatch
writes names the plugin, by its manifest id, whatever channel the entry is on.
The name is set where the caller is minted for a plugin, not per channel, so it
covers `plugin` and `ai` alike. It also covers `mcp` when a connected app's token
reached the records through a plugin's route. That entry names both the app and
the plugin, which answers the second case in the context above: the records now
show which plugin was in between.

- **Where the id comes from.** `ActionCallerFactory.forPlugin` reads it from
  what the host knows about the plugin, beside the `ai` declaration: the host
  object was built for one plugin, from the manifest it read at boot.
  `host.actions.list` and `host.actions.invoke` take a request, a name, an input
  and a filter, and none of them reaches the id. It travels the way the
  connected app does: on the caller handle, as `pluginId` on the `ActionContext`
  a handler receives, and through `actorOf` and `auditActor` into the entry. A
  write service that spreads `auditActor` records the plugin without a change of
  its own, and so does the entry for a change a plugin's route proposes. A
  host service that writes its own `PLUGIN` entry, for a delivery receipt, a
  theme the plugin installs, a device token it issues or revokes, a secret
  setting it writes or a disclosure to one of its declared recipients, sets the
  column from the same host-held id. The board's revocation of a device token
  from its own screen is on `web` and names no plugin.
- **Where it is stored.** In a nullable column of its own,
  `audit_log_entry.pluginId`. It is not a key in `context` the way the connected
  app is. It says which way the act came, so the report prints it next to the
  channel and not in the detail. And `context` is what a call site writes, so a
  key there could, on an entry that cannot be corrected, read as a plugin that
  never dispatched. The column is a plain column, not a relation, for the reason
  the person columns are: a plugin is removed, and its entries stay.
- **What the access report prints.** The "Via" column prints the channel and,
  on the line under it, the plugin's id. A `plugin` or `ai` entry with no plugin
  id was written before the column existed, and the report says so instead of
  leaving the line blank. An entry no plugin dispatched has no such line.
- **Entries already written.** They stay without a plugin id. The log is
  append-only and cannot tell afterwards which plugin wrote an older `PLUGIN`
  entry.

### Schemas in process

_Amended 2026-10-20._ Each entry of `host.actions.list` carries the action's
`inputSchema` and `outputSchema`, as JSON Schema (draft 2020-12). The SDK names
the entry `ActionWithSchemas`: an `ActionSummary` and the two documents.

- **The same documents the catalogue publishes.** Converted by the one call to
  `z.toJSONSchema` the HTTP catalogue's `GET /api/actions/:name` uses, so a
  connector's `tools/list` and the catalogue cannot describe one action two
  ways, and the input schema is the one `invoke` validates against.
- **Filtered exactly as `list` is.** The registry's `listWithSchemas` is built on
  `list` rather than beside it: it converts the schemas of the actions `list`
  returned and of no others. A second filter would be a second place for the
  two to drift, and the drift would describe to a model, or to a connected app
  through the connector, an action the caller is refused. So the channel, the
  surface, the person's capabilities, the plugin's liveness and arming, and the
  capability floor decide which schemas a plugin is handed, as they decide
  which names.
- **On every listing, not by name.** `tools/list` and a model's tool loop want
  every tool at once, and a lookup by name beside `list` would be a way to ask
  about an action that was not listed. The catalogue keeps its split, a list
  without schemas and one action with them, because a screen reading the list
  has no use for them.
- **Built afresh on each call.** Nothing is cached, so a plugin that edits what
  it was handed, to trim a description for a model, edits nobody else's copy.
  The conversion runs at registration already and is cheap beside a model call.
  A cache would have to hand out frozen or copied documents, and is for when a
  listing is measured to cost something.
- **No new error vocabulary.** `ACTION_ERROR_MCP` is already exported by the SDK
  and the same for every action, so it is not repeated on each entry.

A plugin built against this change and run on an older host gets entries
without the two fields, and checks for them, as it checks for `host.actions`.

### Motions put to a meeting on `ai`

_Amended 2026-10-23._ Meeting support drafts a general meeting's agenda, and
without the motions put to that meeting the board has to add them to the draft
by hand. The motions group's three actions stay off `ai`. One read is added for
this purpose, `motion_meeting_list`, and it is the group's only action on `ai`.

- **What it returns.** For one general meeting, each motion the board has put
  to it and the member has not taken back: its id, its title, and whether the
  board has acknowledged it (`SUBMITTED` or `ACKNOWLEDGED`). Motions come in
  the order they reached the board. The read returns at most as many motions
  as one agenda holds items, and `more` says whether any were left out. An
  unknown meeting is refused with `meeting-not-found`, so a wrong id never
  reads as a meeting with no motions.
- **No submitter field.** The read has no field for who submitted a motion: no
  name, no person id, and no branch saying that a name was withheld. The
  service query selects no person column and reads no person, so a motion by a
  member with protected personal data looks like any other in its shape. The
  action declares `freeText` and not `name`, and the catalogue's check of the
  published output finds no field about a person. `protected` is not declared,
  so the registry's rule keeping protected personal data off `ai` does not
  apply. This omits the submitter's data. It does not make the answer
  anonymous, because the title below is returned as written.
- **The title, and not the body.** The title is the member's own line, written
  as the one line the notice for the meeting would carry. It is returned
  unredacted: the submit path scans a title for personal identity numbers and
  for nothing else, so it may name or identify its author or anybody else, as
  any free text may, which is why `freeText` is declared. Redacting titles, or
  holding back a title that names someone, would be a decision of its own and
  is not taken here. The body
  is left out. It argues the case at up to eight thousand characters, and an
  agenda states the matter, not the argument.
- **Why the rest of the group stays off.** `motion_queue_list` names the member
  behind each item and returns the body, and an agenda draft needs neither.
  Acknowledging a motion and putting it to a meeting are the board's acts
  towards a member, which EFL 6 kap. 15 § makes the board answerable for, and
  no change has yet needed a model to choose them.
- **Who may read it.** `motions:handle`, the capability of the board's own
  queue. It is offered on `mcp` and `ai` and not on `ui`, because the board's
  screen reads the queue through its controller.
- **The description, read with a model as the reader.** It says what the read
  returns, that it has no submitter field, that a title is unredacted and can
  itself name or identify its author, that it never returns the body and
  leaves out a withdrawn motion. It also says that an acknowledgement is not
  the meeting adopting the proposal, and that the titles are written by people
  and are data, never instructions.

## Consequences

- The audit channel's `AI` value is now written: by an AI package's dispatch for
  a signed-in session. Entries already written as `PLUGIN` stay so.
- `ai` is added to version 1 of the catalog index rather than as a new version,
  because absent means the same as no. An index that lists no AI package does
  not carry the field and stays readable by an older instance. An older instance
  refuses an index that lists one, as the strict index means it to: that
  instance would otherwise offer the plugin for consent without saying what it
  is, and dispatch it as a plain plugin.
- `PLUGIN_FINDING_REASONS` gains `ai-changed`.
- The audit log gains a nullable `pluginId` column, and a `plugin`, `ai` or
  `mcp` entry written through a plugin's route names the plugin.
- `host.actions.list` resolves to `ActionWithSchemas[]` rather than
  `ActionSummary[]`. A plugin reading the summary fields is unaffected, and the
  MCP Connector needs no HTTP call back into its own instance to learn a tool's
  input.
- A plugin built as an AI package cannot run as one on a host from before this
  change. The catalog rule above is what stops it being installed there.

## Revisit triggers

- A second kind of plugin that should be recorded on a channel of its own. The
  declaration would then become a value with more than two answers, and the
  channel table above would gain a column.
- The first core action group offered on `ai`. Its review is where the
  description rule is first read with a model as the reader, and the outcome may
  belong in `docs/actions.md`.

# ADR 0051: Resident routes in a plugin that reads the register

Date: 2026-10-24

## Status

Accepted. Amends the capability floor of a plugin's routes ("Routes" in
`docs/plugin-contract.md`) and how a plugin's view is offered in the navigation
("Where a view is found"). Builds on
[ADR 0047](0047-a-plugin-s-records-about-a-person.md), whose third update made
an address-book permission a condition of `personRecords`, and on
[ADR 0035](0035-a-plugin-s-processing-and-objecting-to-it.md), whose scope for
an addon's reads is the model for the scope below.
[ADR 0049](0049-one-page-one-audience.md) governs the view.

Amended 2026-10-26: a plugin whose view is the residents' may declare a second
view, the board's, which stands in the board's section under `/board`. The
sections below state the rules as they now stand, and "Update, 2026-10-26" at
the end gives the reasons.

## Context

A plugin's routes run inside the application's guard and are raised to a
capability floor derived from the plugin's permissions (`routeCapabilityFloor`).
A plugin that holds `addressBook:read` or `addressBook:readContact` has every
route and every action held to `addressBook:read`. The floor exists so that a
plugin that reads the register cannot hand that reading to a caller the core
would not let read it, "whether by mistake or otherwise". Only a board seat and
the administrator's grant carry `addressBook:read`.

ADR 0047 lets a plugin keep records about a person, and its third update
requires such a plugin to hold an address-book permission, because whether a
write naming a person is accepted tells the plugin whether the address book
lists that person. Together the two rules mean that **no resident without a
board seat can call any route of a plugin that keeps records about a person.**
The example plugin says so in its own comment: a route that any resident may
call for their own record is not something a plugin can ask the host for.

The first module this stops is parking share. Offering a space for some days and
claiming one are a resident's acts. Today only a board member who also lives in
the house could make them, and `offeredSection` hides the plugin's view from
everybody below the floor, so its screen is not offered to residents either.

What a resident's route needs is narrow:

- `host.addressBook.caller(request)`, to know which resident is asking;
- `host.personRecords` reads and writes: the caller's own offers and claims, and
  a list of other residents' open offers, which the plugin reduces to a space
  label and the dates;
- not `residents()`, `apartments()`, `summary()` or any contact field.

## Threat model

The parties are the resident calling the route, the other residents, the plugin
(whose permissions the board consented to), and the board. What a resident
route could hand the caller about other residents:

1. **The register.** `residents()` returns every listed person with their
   apartment, residency and membership, and with `addressBook:readContact`
   their email address and telephone number. `apartments()` returns the
   association's apartments and their addresses, with no person in them, and
   `summary()` returns three counts: the apartments, the residents listed to
   the plugin and the members among them. A route that returned the first would
   give every resident a second resident directory, on none of the core's
   rules. The other two name nobody, but a resident route has no use for them,
   and a listed count read before and after a neighbour moves in says whether
   the address book lists that neighbour, so all three are refused.
2. **Whether a person is withheld.** A route that takes a person id from the
   caller and writes a record or an audit entry naming that person learns
   whether the address book lists them to the plugin, and can pass the answer
   on. A neighbour the caller knows lives in the house and is not listed has
   protected personal data, a restriction or an objection. This is the question
   ADR 0047's third update put behind `addressBook:read`; through a resident
   route anybody could ask it. Protected personal data exists for people whose
   safety depends on it, so this is the gravest of the six.
3. **Other residents' records.** Who offered which space for which days, and
   who claimed it. The plugin reads whole records, subject included, and
   decides what to return. The host does not see the response.
4. **What a record's absence says.** A record about a person who becomes
   withheld leaves the plugin's reads (ADR 0047, "What a plugin's records tell
   it"). If a resident route lists other residents' records, the caller sees the
   record go. To the caller this reads as an offer withdrawn or claimed, unless
   the plugin says why it went.
5. **Indirect identification.** A space label can be tied to an apartment by
   anybody who knows the courtyard. This is the feature, and the resident who
   offers the space makes that choice. The plugin's screen has to tell them what
   neighbours will see before they offer.
6. **Data carried round the route.** Register data the plugin read in a job or
   in a board route, kept in memory or in a record, and served from a resident
   route. No rule the host applies during the request reaches this.

Three callers hold `self:manage` and should not reach a resident route at all:
the property manager, an external party the core never lets read the address
book; a former resident whose account outlived their residency; and a
board member or administrator who does not live in the house. The address book
does not list any of them, so `caller` answers them `notListed`. A plugin that
forgets to ask would still answer them.

Any narrowing of the plugin's host object has two ways round it that do not
need a hostile plugin. One is code of the plugin's that NestJS runs around the
handler: a guard, an interceptor, a pipe, an exception filter or a custom
parameter decorator the plugin puts on the route runs before or after the
handler, and a check or a scope that covers only the handler leaves it out.
The other is another plugin's code: an addon the route calls through
`host.extensions.invoke` runs on its own host object with its own permissions,
so an addon that reads the register or the finances would answer the route with what the plugin itself was refused, and
its own record writes would answer the "is this person listed?" question again.

What the host can enforce is bounded as everywhere else in the plugin API.
Permissions are not a sandbox: a plugin's server code runs at full process
privilege, and catalog curation is what stands between an instance and hostile
code ([ADR 0003](0003-plugin-loading-and-module-resolution.md)). The host's
rules hold an honest plugin to what it declared and turn its likely mistakes
into errors it meets in its own tests. Catalog review is the bound on the rest.

## Options

**(a) Resident routes declared in the manifest, held to `self:manage`, shown on
the consent screen.** Catalog review reads what each returns, as it reads a
bundle's writes to `host.personRecords` today. Threats 1 to 6 are left to
review, and so are the three callers above. The floor's own reason, a mistake
as well as intent, no longer holds on those routes.

**(b) As (a), with the host narrowing what such a route can reach.** On a
resident route the host refuses the register reads, refuses to name any person
but the caller as a new subject, and answers only a caller the address book
lists. Threats 1 and 2 and the three callers become the host's to enforce
against an honest plugin. Threats 3 to 6 stay with review, and the consent
screen can say truthfully what the plugin cannot do on those routes.

**(c) Keep the floor, and expose resident acts only as actions the core
dispatches.** `host.actions` lists and invokes a plugin's action only for a
caller who holds the floor of the plugin's routes, so this is the same floor and
no answer on its own. Lowering it per
action is the same decision as (b), taken on a surface that also reaches
connected apps and the assistant, without a path to declare, and without the
view's reads, which are routes.

## Decision

Option (b). A plugin declares the routes a resident may call, the board sees
them before anything is downloaded, and on those routes the host lowers the floor
and narrows the host object.

### Declaring resident routes

```jsonc
{
  "openbrf": {
    "id": "parking-share",
    "permissions": ["addressBook:read"],
    "residentRoutes": [
      { "path": "offers", "titleKey": "residentRoutes.offers" },
      { "path": "claims", "titleKey": "residentRoutes.claims" },
    ],
    "view": { "section": "building" },
    "boardView": {
      "module": "./BoardView",
      "titleKey": "boardView.title",
      "capability": "bookings:configure",
    },
  },
}
```

- `path` is written as a device route's is: lowercase, without a leading
  slash, segment by segment, covering itself and everything below it. `offers`
  above is `/api/plugin/parking-share/offers` and every path beneath it. How a
  handler is matched against it differs from a device route; see "The floor on
  a resident route".
- `titleKey` is a text key in the plugin's own namespace that says what a
  resident does there, such as "Offer your parking space for some days". The
  catalog entry carries the same title in Swedish and English, written by the
  curator, as it carries an extension point's
  ([ADR 0030](0030-plugins-that-extend-plugins.md)), because the consent screen
  shows it before the plugin's locale files are on the instance.
- At most eight. Two may not overlap, and none may cover the plugin's
  `oauthProtectedResource`: what a connected app may do there is decided by its
  grant, and this ADR does not widen it.
- Only beside `addressBook:read` or `addressBook:readContact`. Without either
  every route already answers every account, and the declaration would lower
  nothing.
- Not beside `finances:read` or `finances:recordDelivery`. Their floor guards
  the books, which the narrowing below does not cover.
- Not beside a view in the `board` section. A view whose plugin answers
  residents is a resident's page (ADR 0049). The board's screen for the same
  records is the plugin's board view (see "The view and the navigation").
- Not beside an extension point. `host.extensions.invoke` calls only an addon
  that contributes to a point the plugin's own manifest declares, so a plugin
  that declares none has no other plugin's code to call, and no addon's
  permissions reach a resident route. The plugin may still be an addon itself:
  its contribution runs when its host plugin calls it, in the host plugin's
  request and not on a resident route. Parking share declares no extension
  point. Carrying the scope into the addon's host object instead is weighed
  under "Rejected alternatives".

A manifest that breaks one of these rules is `manifest-invalid`, and the catalog
index refuses an entry that breaks one, so it is never offered for consent.
Device routes need no rule of their own:
[ADR 0031](0031-a-device-token-for-a-plugin-s-own-routes.md) already refuses
them beside an address-book permission.

The declaration is in the manifest and not in a decorator, because the consent
screen has to show it before the bundle is downloaded and the seal has to read
it before the plugin's code runs.

### The floor on a resident route

A handler mounted only on paths under a resident route is held to
`self:manage` instead of the floor. A `@RequireCapability` of its own still
applies, so a resident route may ask for more and never for less. A handler
with any path outside the resident routes keeps the full floor. The seal
decides this per handler, and a controller may hold both kinds.

The test is containment: every path the handler's pattern can match must lie
under a resident route. A handler is inside only if the segments of its full
mounted pattern, as deep as the resident route goes, are plain text equal to
the route's segments. A segment that holds `:`, `*`, `(`, `{` or `?` at that
depth, including Fastify's `::` escape for a literal colon, is outside. So
`offers/:id` and `offers/*` are inside `offers`, while `:id`, `off*`,
`offers*` and a parameter with a pattern at that depth keep the full floor, and
a mistake fails closed. This is not the question the device routes' matcher
answers (`patternReaches`, whether a pattern could reach a path), which leans
towards yes; reusing it here would lower the floor for patterns that also
match paths outside the resident route.

The plugin's actions keep the floor. An action is reached through connected
apps and the assistant as well as the web interface, and a resident act a
plugin wants on that surface is a revisit trigger, not part of this decision.

### Only a listed caller

The application's own guard (`AuthorizationGuard`) checks that the caller is a
person the address book lists to this plugin: the person `caller` would answer
`listed`. It does so right after the per-handler floor, in the same place, so no
code of the plugin's runs for anybody it refuses: not a guard, a pipe or an
interceptor of the plugin's, and not the handler. Anybody else is refused with
a 403 and reason `resident-route-not-listed`. This
covers the property manager, a former resident, a board member or administrator
who does not live in the house, a person with protected personal data, a person
under a restriction and a person who objected to the plugin's processing.

Every one of them gets the same refusal, and it is about the caller alone, who
knows their own situation. The plugin's view reads the reason and tells the
person that the module is not available to them and to ask the board, as ADR
0047 asks of a plugin whose `caller` answers `notListed`. The plugin still calls
`caller` to learn who the resident is. On a resident route it answers `listed`,
unless the person's state changed while the request ran.

### What a resident route can reach

For the length of the handler's work the host holds the request in a scope, as
it holds an addon's answer to an extension point (`extension-call.ts`). The
scope follows the handler's own async work, including work the handler leaves
running after it has answered, which stays narrowed. Unlike the extension-call
scope it is not closed when the handler settles: work left running can still
write a record, and must still be held to the rules below.

The scope has to cover all of the plugin's code that runs for the request, not
the handler alone. So the seal refuses a guard, an interceptor, a pipe
(a parameter's included), an exception filter or a custom parameter decorator
(one made with `createParamDecorator`, whose factory NestJS runs before the
handler even when the route has no pipe) of the plugin's on a handler under a
resident route, and the plugin is refused at load. It does so whether the
enhancer is named on the handler or on its controller, and whether the
parameter decorator is declared on the handler or inherited from a base class
the controller or handler extends. The framework's own parameter decorators
(`@Body`, `@Param`, `@Query`, `@Req` and the like) are not custom and stay. The
handler is then the only code of the plugin's between the core's guard and the
response, and the scope opened around it covers everything, with one
exception that the scope itself must close: an Observable the handler returns.
A cold Observable, `defer(() => host.addressBook.residents())` for one, runs its
producer when NestJS subscribes to it after the handler has returned, outside
the scope, and an async handler that returns one hands it over the same way.
That needs no enhancer or parameter decorator of the plugin's. So the host
wraps the handler, and when its result, or what an async handler resolves to,
is an Observable, it returns an Observable of its own whose subscription, and so
the producer and every emission, runs inside the scope. Entering the scope when
the handler is invoked does not carry into that later subscription, and keeping
a flag set does not either. A handler's result of any other kind is returned as
it is. Refusing a returned Observable, and so a server-sent-events stream, before
NestJS subscribes would also fail closed, but a resident route has no use for
one, and a plugin that returns one would have to be told at load, which the
seal cannot see from the handler's declaration. So the subscription is
scoped. Wrapping each
enhancer and each parameter factory in the scope instead would do the same with
more to get right, and a missed one would fail open. A resident route validates
its input, and resolves anything it would have taken from a parameter
decorator, in the handler's own body.

Inside the scope:

| Host member                                      | On a resident route                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addressBook.caller`                             | Answers only for the request the scope was opened for. Any other request is refused with `PluginResidentRouteError`.                                                                                                                                                  |
| `addressBook.residents`, `apartments`, `summary` | Refused with `PluginResidentRouteError`.                                                                                                                                                                                                                              |
| `personRecords.get`, `list`                      | As everywhere, other residents' records included.                                                                                                                                                                                                                     |
| `personRecords.put`                              | The subject must be the caller, or the subject of the live record the write replaces, which the plugin can read. Anything else is refused with `PluginRecordSubjectError`.                                                                                            |
| `personRecords.delete`                           | As everywhere.                                                                                                                                                                                                                                                        |
| `audit.record`                                   | A request given for the actor must be the scope's own, as for `caller`; another is refused with `PluginResidentRouteError`. A `subject` must be the caller, or the subject of a record the plugin can read; anything else is refused with `PluginRecordSubjectError`. |
| `recipients.fetch` with `disclosure.subjects`    | Each subject must be the caller, or the subject of a record the plugin can read. Anything else is refused with `subject-refused`, the answer a protected or restricted person and an unknown id already get, so the three cannot be told apart.                       |
| `actions.list`, `invoke`, `propose`              | Dispatched only with the scope's own request, as for `caller`. Any other request is refused with `PluginResidentRouteError`.                                                                                                                                          |
| `extensions.invoke`                              | Not reachable: the plugin declares no extension point.                                                                                                                                                                                                                |
| Every other member                               | As everywhere.                                                                                                                                                                                                                                                        |

The three subject rules do not depend on whether the person named is listed, so
a refusal tells the plugin nothing about that person. What they allow is either
the caller or a person the plugin already holds a readable record about, which
the plugin knows already. A claim on another resident's offer is the claimer's
own record, and a status the plugin writes on the holder's offer is a rewrite
under the holder's existing subject. Both are allowed.

`caller` is held to the scope's own request because a plugin that kept another
request it was handed, in a singleton for "the current request", a common
mistake in a NestJS service, would otherwise read the resident behind that
request, contact details included with `addressBook:readContact`. The mark that
names the person on a request ends with its response, so only a request still
being served could be read this way, and that is the one the rule refuses.

A plugin's actions dispatched through `host.actions` are held to the floor of
the plugin they belong to, read from its permissions and not from the handler,
so a resident caller does not reach an action of this plugin or of another
plugin that reads the register. The floor alone does not say whose capabilities
an action is checked against: the action caller accepts any request that is
still authenticated and checks the person behind it. So inside the scope the
host passes the scope's own request to the action caller and refuses another,
as for `caller`; a plugin that kept a still-live board request in a singleton
could otherwise dispatch an action with the board member's capabilities from a
resident's request.

A job the route enqueues runs outside the scope, as every job does, and so
does a value the plugin computed before the request and kept. Neither is the
host's to narrow: a job that writes a record or an audit entry naming a person
id the caller put in its data would answer the "is this person listed?"
question one step later, and a `residents()` read kept in memory from a board
route would reach the resident route with no host call to refuse. Both are
threat 6, and catalog review reads them (see "What catalog review reads"). The
contract tells a plugin's own tests of a resident route to start with nothing
read beforehand, so that a register read the route depends on fails in the
test and not in review.

The narrowing is worth having even though it is not a sandbox. It turns the
two mistakes most likely to leak something, a screen that lists neighbours by
name and a route that names a person the caller picked, into errors the
plugin's own tests meet. And it makes the consent screen's statement about
those routes true for an honest plugin.

### The view and the navigation

A plugin that declares resident routes is offered its view, in the section it
names, to an account that holds a residency today, and to nobody else.
`offeredSection` reads the account's residency beside its capabilities for such
a plugin, instead of the routes' floor. A plugin without resident routes is
offered on its floor as before.

A resident whose `caller` would answer `notListed` is still offered the entry,
and the view tells them that the module is not available to them. Deciding the
entry by `caller` would mean an address-book read per plugin on every navigation
answer, and the navigation is not where access is decided. A board member or an
administrator who does not live in the house is not offered the entry, because
the routes behind it would refuse them.

The view is one page, and its audience is the residents. A plugin whose board
needs a screen of its own for the same records declares it as a second view,
`boardView`, which is the board's:

- The host mounts it at `/board/plugin/<id>`, one of the board's pages
  (ADR 0049, decision 1), under the board's sign and with the sentence saying
  who sees it, as every board page carries them. Opening it ends the resident
  preview, as opening any address under `/board` does, and no preview offers it.
- Its entry stands in the board's section only, in the queues group, after the
  plugins' own views. The residents' view is offered in its own section.
  Neither the navigation nor the host's frame round the residents' view offers
  a way to the board's, and the residents' view links to nothing of the board's
  either.
- It names the capability the board's routes behind it require, such as
  `bookings:configure`, and the host offers it to an account that holds that
  capability, the floor of the plugin's other routes and a board seat, which
  is the rule of the board's section. Anybody else who opens its address reads
  the sentence every refused board page says, and the plugin's module is not
  loaded for them. The plugin's routes still refuse whoever lacks what they
  require: neither the navigation nor the page is where access is decided.
  The host does not raise the routes to the capability, so it refuses at load,
  as `module-refused`, a plugin that mounts routes a person can reach and
  requires the capability on none of them. Whether each route the view calls
  requires it is the plugin author's to get right.
- Its module is its own, exposed from the same remote as the view.

A board view is a second view, so it stands beside a view, and that view names
a section that is not the board's. A plugin that reads the register answers
only the board unless it declares resident routes, so without them its view is
the board's already, and a second view would be the same audience again: such
a plugin may not declare one. A plugin that reads nothing answers residents
already and may declare one without resident routes. Each of these is
`manifest-invalid` when broken.

### The consent screen

The consent screen shows the resident routes beside the address-book permission,
in the association's language. In English:

> **Residents can use this plugin.** Any resident the address book lists to it
> can, without a board seat: offer your parking space for some days; claim a
> space a neighbour offers. There it can tell which resident is asking and read
> and write its records about people, other residents' records included. It
> cannot read the register there. What it shows a resident of other residents'
> records is the plugin's choice; its description says what that is.

The list is the routes' titles, and each title opens to its path.
`openbrf plugin add` prints the same section, the titles with their paths,
before it asks for consent, as it prints the device routes.

The install records the resident routes the board consented to, on either path,
as it records the consented device routes. A republished version that adds a
resident route, or moves one to cover a path it did not cover, is refused at
load as `resident-routes-widened` until the board consents again. The check
compares with what was recorded, and an install with nothing recorded, such as
one made before this change, consented to none. A version that drops one loads,
because it answers fewer people.

### What catalog review reads

For every resident route, beside what ADR 0047 asks of a bundle's writes to
`host.personRecords`:

- **What it returns about anybody but the caller.** Only what a feature the
  description names needs, such as a space label and dates. No person id, name,
  apartment or contact of another person, unless the feature is to show it and
  the description says so.
- **What it says when another person's record goes.** An offer that leaves the
  list is shown the same way whatever the reason, so a withdrawal, a claim and a
  record that left the plugin's reads cannot be told apart. The same holds for a
  write refused with `PluginRecordConflictError`: a key held by a record the
  plugin cannot read conflicts with `actualRevision` null, one held by a
  readable record with its revision, and the resident is told the same in both
  cases.
- **What reaches it from elsewhere.** No register data read in a job, a board
  route or a settings screen reaches a resident route's answer through memory,
  `host.records` or a person record's value, and no register read is kept in
  memory to be served across routes.
- **What it hands a job.** No person id the caller supplied reaches a job's
  data, because a job writes records and audit entries outside the scope.
- **What the screen tells a resident before they act.** What their neighbours
  will see of what they offer or claim.

A listing whose resident routes fail one of these is not listed.

### The contract, the SDK and the order of release

The change is additive to contract version 1, and `apiVersion` stays `1`.

- **`@openbrf/plugin-sdk`:** `residentRoutes` in the manifest schema, with one
  rule function the manifest and the catalog index share, as
  `personRecordsRuleIssues` is shared; the `PluginResidentRoute` type; and
  `PluginResidentRouteError`. A minor release.
- **The catalog index** carries `residentRoutes` beside `deviceRoutes`, each
  with its path and the curator's title in Swedish and English, so the consent
  screen can show them before the download. Index version 2 has not
  shipped in a core release yet. If this lands before one does, the field joins
  version 2. Otherwise it is a new index version, by the contract's rule that a
  new field is a new version.
- **The core:** the seal's per-handler floor by containment, and its refusal
  of enhancers and custom parameter decorators on a resident route's handler,
  inherited ones included; the listed check in
  `AuthorizationGuard`; the scope and the narrowing in the host object, with the
  scope held round the subscription of an Observable the handler returns, also
  one an async handler resolves to; `offeredSection`; the consent screen and `openbrf plugin add`, with their text
  in Swedish and English; the consented resident routes recorded with the
  install, and the `resident-routes-widened` finding; and reading the field from
  the catalog.
- **Regressions the core change carries**, each failing when the guard it tests
  is removed:
  - A custom parameter decorator on a resident route's handler that calls
    `residents()`, declared on the handler and again inherited from a base
    class, causes load refusal, or, if it ever ran, `PluginResidentRouteError`.
    It never returns register data to the resident, and a decorator-free
    handler on the same controller still loads. The test goes through the real
    router, as the lifecycle is NestJS's and not the seal's alone.
  - A decorator-free resident handler that returns `defer(() => residents())`
    never sends register data: the read raises `PluginResidentRouteError` when
    NestJS subscribes, or the result is refused before the producer runs. A
    second case returns the same Observable from an `async` handler, and a
    control returns a Promise of the same read and is refused too. The test goes
    through the real router and its response handling, since NestJS subscribes
    after the handler has returned.
  - A plugin that keeps a board request in a singleton and dispatches
    `host.actions.list`, `invoke` and `propose` with it, or gives it to
    `host.audit.record` for the actor, while a resident's request is served
    concurrently is refused with `PluginResidentRouteError` for the board
    request, and the resident's own request is served, whichever request began
    first.
- **`docs/plugin-contract.md`:** a "Resident routes" section and the changes to
  "Routes" and "Where a view is found", written with the core change rather than
  ahead of it. It tells a plugin to test its resident routes with nothing read
  beforehand.
- **The example plugin** declares its `away` routes as resident routes, and the
  comment saying the host cannot do this goes.

An instance that predates this ignores `residentRoutes`, because the manifest is
not read strictly. Its routes stay at the floor and its view is not offered to
residents, so the plugin fails closed and needs no feature check to be safe. Its
view can tell the two refusals apart by their reasons.

The order is: the SDK and the core in one release, then the catalog index, then
parking share declaring its resident routes against that SDK, and only then
parking share's catalog listing.

## Consequences

- A plugin that keeps records about a person can serve residents, and parking
  share can be offered to the residents it is for.
- A resident route's answer about other residents is bounded by catalog review
  and not by the host (threats 3 to 6). The consent screen says so.
- The host can tell, on every host call, whether it is serving a resident
  route. The scope is the second of its kind, after the extension-call scope,
  and has the same limits: it follows async work begun inside it, and nothing
  begun outside. A returned Observable is begun outside, when NestJS subscribes
  to it, so the host subscribes to it inside the scope.
- A resident route costs one address-book read before the handler, for the
  listed check.
- A plugin's floor is now decided per handler and not per controller.
- A protected, restricted or objecting resident cannot use such a plugin, as
  ADR 0047 already meant: `caller` answered them `notListed`, and now the host
  refuses them before the plugin's code runs.
- A plugin with resident routes has its board's screen as a second view, under
  `/board`, and not as a part of the residents' view. It cannot read the
  finances, and cannot be extended by addons.
- A resident route's handler has no guard, interceptor, pipe, exception filter
  or custom parameter decorator of the plugin's; it validates its input and
  resolves its own parameters in its own body.

## Rejected alternatives

- **Option (a), resident routes without the narrowing.** The floor's reason
  covers mistakes, and the two most likely ones, a screen of neighbours' names
  and a route that names a person the caller picked, would then be found only
  in review of a bundle. The second leaks who has protected personal data.
- **Option (c), actions dispatched by the core.** Actions share the floor. See
  "Options".
- **One flag that lowers the floor for the whole plugin.** Every route would
  open, the board's own included, and the consent screen could not say which
  acts a resident may take.
- **A decorator in the plugin's code instead of a manifest field.** The board
  consents before the bundle is downloaded, and the seal reads the declaration
  before the plugin's code runs.
- **Dropping ADR 0047's address-book requirement for `personRecords`.** It would
  reopen the question the third update closed, for every account and on every
  route.
- **Limiting a resident route's reads to the caller's own records.** The feature
  needs other residents' open offers. A plugin would copy them into records it
  keeps about the caller, which is worse.
- **A host-held projection of what residents see**: a collection declares which
  fields of a record about another person a resident route may read, and the
  host returns those fields without the subject. It would make threat 3 the
  host's to enforce. But a route that rewrites the holder's offer when a claim is
  made needs the whole record, and a second, partial read model is more than
  the first resident-facing plugin needs. It is the first answer to try if
  review proves not enough (see "Revisit triggers").
- **A capability that only residents hold, as the floor.** No such capability
  exists; the board holds every resident's capability. Making one would put a
  role into the capability model to answer a question the address book already
  answers, and it would still admit a protected or objecting resident, whom the
  listed check refuses.
- **Leaving the listed check to the plugin.** The three callers above hold
  `self:manage`, and a route that forgets to ask would answer them, the property
  manager included.
- **Carrying the scope into an addon's host object.** The extension call
  records its caller, so the addon's reads and writes could be narrowed by the
  same table. It would let a plugin with resident routes have addons, which no
  plugin needs yet, and it would make every rule above one that has to hold on
  two host objects. Refusing extension points is one manifest rule and fails
  closed.
- **Wrapping the plugin's enhancers in the scope.** Each kind (guards,
  interceptors, pipes, filters, and the factories of custom parameter
  decorators) is called by NestJS at its own point, so each
  would need its own wrapping, and a kind or a point missed would leave code
  outside the scope that the plugin's tests would not notice. Refusing them
  fails closed.

## Revisit triggers

- **A resident act needs to be an action**, reached by a connected app or the
  assistant.
- **A plugin's board needs more than one page** for its records, or a page in
  another group of the board's section than queues. The board view is one page
  in one group.
- **A plugin needs resident routes beside the finance permissions.**
- **A plugin with resident routes needs addons**: carry the scope into the
  addon's host object (see "Rejected alternatives").
- **A resident route needs an enhancer or a custom parameter decorator** that
  cannot live in the handler's body: run it inside the scope, after the listed
  check.
- **A resident route needs to name a person other than the caller**, such as a
  resident choosing a neighbour to swap with. The answer must not let the caller
  ask whether a person is listed.
- **Catalog review finds a resident route returning more about other residents
  than its description says**, or a second plugin with resident routes is
  submitted: consider the host-held projection above.

## Update, 2026-10-26

As first accepted, this record gave a plugin with resident routes one view, the
residents', and named a board screen for the same records as a revisit trigger.
Parking share was the first to meet it. Its board keeps the spaces and assigns
them, and reads the offers and claims, through routes of its own. Its first
screens put the board's page inside the residents' view, at an address after a
`#`, which is a board zone on a house page by another name: ADR 0049 decision 1
puts every board page under `/board`, in the board's section, and the resident
preview reads `/board` as where a page is the board's. Without a page there,
nothing in the interface reached the board's routes.

Options considered:

- **A board zone or an address inside the residents' view.** The mixed screen
  ADR 0049 removed, and a page the preview cannot tell from a resident's.
- **A second plugin for the board.** Two installs and two consents for one
  feature, and a plugin's records are its own, so the board's plugin could not
  read the offers and claims.
- **A list of views of any length, each naming its audience.** One audience per
  page and two audiences in the product make at most two views, so a list would
  need rules to say what the second field already says, and a third view would
  have no audience to be for.
- **The board's page at an address under the plugin's own**, such as
  `/plugin/<id>/board`. Outside `/board`, so the preview would not end there and
  the page would not be the board's by its address.

Decision: the second view is a manifest field of its own, `boardView`, as
"The view and the navigation" now states. The view the board's routes require a
capability for is offered on that capability, so a board member without it is
refused the page as their requests would be refused, rather than offered a page
whose every request fails.

An instance that predates this ignores `boardView`, because the manifest is not
read strictly. The plugin's residents' view is offered as before, and its board
has no page, so it fails closed. A plugin with one view, in any section,
including the board's, keeps its address at `/plugin/<id>` and is offered as
before.

The change is additive to contract version 1. `@openbrf/plugin-sdk` carries
`boardView` in the manifest schema, the `PluginBoardView` type and
`boardViewRuleIssues`, the rule above that the manifest applies, in a minor
release. The catalog index does not carry it: the board consents to what a
plugin may do and read, and a page is neither.

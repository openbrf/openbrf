# ADR 0008: The action registry

Date: 2026-09-14

## Status

Accepted

## Context

Until now there has been exactly one place where "may this person do this" is
decided: the class-level `@RequireCapability` a controller declares, enforced by
the global `AuthorizationGuard` on every route. The value of that arrangement is
not that it is tidy. It is that there is no second opinion to disagree with the
first.

Two things are being built on top of this platform that each need a caller which
never passes through a route: a paid MCP connector, so a board member can ask a
connected app to publish a news item, and a paid AI package that does the same
from a prompt. Both need dispatch - something that takes a name and a payload
and performs one of the things the platform can do. Both are external code
holding a token that acts as a person.

The naive shape is a second authorization path. Each caller resolves who is
asking, decides what they may do, and calls a service. That is the shape to
avoid, and the reason is not abstract: a capability decided in two places is a
capability that can be decided differently in two places, and the one that is
wrong is the one nobody is reading when the question is asked.

There is a second problem underneath. A plugin already runs inside this process,
with its own NestJS module, and it will want to offer its features to the same
callers. A plugin holding dispatch is a plugin that could dispatch as somebody
else unless the design forbids it.

## Decision

### One choke point, and the services stay ignorant

`ActionRegistry.invoke()` is the only way an action is performed. It resolves
the caller, checks the surface and the arming, refuses writes in read-only mode,
checks the token's scope, re-derives the caller's capabilities through
`PrincipalService.forPerson`, checks one capability, checks plugin liveness and
the plugin's own capability floor, parses a strict input, calls the handler,
validates the output, and writes no audit entry of its own.

The write services are not given a principal and check nothing. This is the part
most likely to be undone by a later change that means well, so the reason is
recorded here: a check inside `PagesWriteService` would be a third opinion, able
to disagree with both the guard and the registry, and `getAllAndMerge` unions
rather than overrides, so a service-level check could never narrow anything
anyway. What crosses into a service is an `ActorContext` - a person, a channel,
and the connected app if there was one - which is what its audit entry needs and
nothing more.

Identical authorization therefore rests on four facts, and two of them are
tested directly: every first-slice action declares the same capability its
controller declares, both paths call the same `PrincipalService.forPerson` with
no cache, both ask a `Set` for membership, and no action reaches a service method
no controller reaches.

### Capabilities are re-derived on every call, and nothing is cached

`forPerson` runs inside `invoke()` on every call, after the scope check and
before the capability check. No snapshot, no claim carried on a token, no
memoisation. This is the line that makes "a token never exceeds the person's
current capabilities" true at the instant of use rather than at the instant of
consent: a board term ending narrows every connected app that person authorised,
the same night it narrows the person.

The cost is one query per call. It is accepted.

### The caller is a handle, not a description

`invoke()` takes an `ActionCaller`, which carries nothing. The facts behind it -
the person, the channel, the connected app, the token's scopes - are held in a
`WeakMap` inside `ActionCallerFactory`, and `resolve()` refuses an object it did
not mint. A plugin holding the same dispatch surface cannot name a person it was
not given, because it has nothing to name one with.

The same problem appears one level out: a plugin dispatches by handing back the
request its own route received, and the registry reads the person from that
request. An object the plugin built itself would do just as well. So core marks
every request it authenticates with a module-private symbol that is not exported
from `@openbrf/plugin-sdk`, and the factory refuses an unmarked request.

`ActionsModule` is deliberately not `@Global()`. Twelve of the platform's
modules are, which puts everything they export into the root injector where a
loaded plugin's constructor can ask for it by token; the module seal refuses a
plugin provider that declares one. The registry is kept out of reach by
construction instead, and a plugin reaches dispatch only through `host.actions`,
which carries the plugin's identity with it.

The seal's list is a classification of every root-injector export rather than a
short list of the obvious ones, and `scripts/check-plugin-injections.mjs` under
`pnpm lint:guards` refuses a `@Global()` export that appears in neither the
denied list nor the allowed one. The defect that produced the previous gap was
not a wrong entry but a missing one - the list named six of thirteen, and three
of the seven it missed are services the host deliberately wraps before it hands
them over, so a plugin injecting the mailer directly got neither the `mail:send`
permission the board consented to nor the template stamped with its own id. A
thirteenth global module now has to be classified rather than merely added.

A token is matched by name, and a name is read from all three kinds NestJS
accepts: a class's own name, a symbol's description, and a string token as the
string. Reading only the first is why `ENV` and `PROTECTED_RESOURCE` were
inexpressible rather than merely absent - neither is a function, so the old
check passed straight over both however the list was spelled.

The check covers what a provider DECLARES. A provider that resolves a class at
runtime rather than declaring it is still not read, which is why the injector
handles - `ModuleRef`, `ModulesContainer`, `Reflector`, `DiscoveryService`,
`LazyModuleLoader`, `HttpAdapterHost` - are on the denied list: declaring one is
refused, so the runtime path costs a plugin a boot finding rather than nothing
at all. Nothing in core injects any of them, so denying them breaks no existing
plugin.

None of this closes the hole against a plugin that means harm, and it does not
claim to. A plugin's factory runs at full process privilege before the seal sees
anything, `require` is unhooked, nothing is signed, and `permissions.ts` and the
plugin contract both state that permissions are not a sandbox and that catalogue
curation is what stands between an instance and hostile code. One route is
recorded rather than closed: `pluginHostBinding` is an exported module-level
singleton provided to the injector as the same object, so a `require()` of the
compiled file yields `ActionRegistryService` and `ActionCallerFactory`. Making
the binding unexported is contained work, but it defends only against deliberate
reach, and a `require('@prisma/client')` gets a database handle regardless.

### The manifest proposes, the administrator arms

A plugin declares its actions in its manifest - id, capability, effect,
personal-data categories, eligible surfaces - and the board sees them on the
install consent screen before anything is downloaded. That placement is forced by
the loader's own rule: nothing which can refuse a plugin may run after the code
that executes it.

Declaring an action does not offer it beyond the instance. An administrator arms
each one, individually, on the plugin's own screen at `association:manage` - the
same authority that installed the plugin and consented to what it may do. Adding
a channel can therefore never expose an existing action.

Arming is read at the moment of the call rather than cached, which is what makes
disarming bite immediately, and it is cleared whenever the board consents to a
republished version. That last rule exists for a specific failure: a new version
keeping the id `summary` while changing its capability from `self:manage` to
`site:manage` would otherwise keep its arming and go live at the wider capability
with nobody deciding. An action whose capability changed is a different action
wearing the same name.

### What no action may ever do

`action-denylist.ts` holds four constants, read by the boot gate and by the
contract test. No action of any kind may declare `systemRole:manage`,
`boardPosition:manage`, `association:manage`, `protectedData:reveal` or
`addressBook:write`: these are the ways authority moves and the way protected
personal data is revealed, and Beslutslogg 64 puts them outside every token and
every prompt. A plugin's action may ask only for `self:manage`,
`addressBook:read` or `site:manage`. No handler may be bound to a service that
writes a statutory register - which is the half a name pattern cannot do, since
an action called `update_household` walks past any regex.

They are explicit constants rather than a rule derived from something else,
because a reviewer has to be able to check the list against the decision without
running the program.

### What a person-bearing action must satisfy

Two rules, and they are what the second slice is for. The first action that
names a person is where they bite.

**Rule 1, the exposure rule.** An action that can return a field of a person
carrying protected personal data (skyddade personuppgifter) declares `protected`
among its `personalData` categories, and an action declaring `protected` may not
list `mcp` or `ai` among its surfaces. Beslutslogg 64 is what it implements:
that data is outside every token and every prompt. It is refused in two places
over two different objects - in the plugin gate over a manifest declaration,
where a board can still act on it, and in `ActionRegistryService.register` over
the registered definition, which is what makes it hold for a core action. Two
moments of one rule, not two opinions: a declaration and a definition can
disagree, and a later change that made either read the other would collapse the
distinction that exists because they can.

Read as a declaration rule that is nearly empty, because a declaration is
written by hand. Read as a **binding** rule it decides what may be registered at
all, and it is stated here in that form:

> An action may bind a read only where the masking or the omission happens
> inside the service method its handler calls. Where the decision sits higher up
>
> - in a controller, in a response mapper, in a component - the action reaches
>   past it, must declare `protected`, and is then offered nowhere worth offering
>   it.

The product makes the test easy to apply, because the pattern is already
everywhere: eight services withhold a protected person's name from their own
view, inside the service, with a discriminated branch rather than a blank, and
the address book excludes the row at the query.

**A withheld value is a different shape in a published output document, never an
empty one.** A masked or withheld field is published as a discriminated union
over strict object branches, each branch described, and never as a nullable
string. The reason matters more for a caller that is a model than for a screen:
a model reading `""` or `null` concludes the association holds nothing, while a
model reading a branch named `protected` concludes the value is withheld, and
the difference decides whether it asks a person or concludes there is nobody to
ask about.

**Rule 2, the provenance rule.** An action that returns stored content says so
in its description, in both languages: that the text is written by people and is
data, never instructions. The text then travels unchanged - nothing strips,
summarises, re-encodes or annotates a resident's words on the way out, because
every one of those is a second thing that can be wrong about what was written -
and nothing a resident wrote becomes an input the platform then acts on.

**The declaration is checked, the cheap half only.** `PERSON_FIELD_CATEGORIES`
sits beside the denylist, mapping a property name a person-bearing output uses to
the category it implies, and a contract test walks each action's published output
document and fails on a property whose implied category is undeclared. It cannot
prove a declaration complete and the test says so in its own comment: a service
that starts returning a person's town under a property called `place` passes it.
The other direction - proving that a declared category is a reachable one - is
not built, because it would need the registry to know what every bound service
can return, which is the knowledge this decision keeps out of it. What stands
behind both gaps is what stands behind the denylist: a reviewable constant and a
review.

### The first slice writes the website and cannot mail anybody

Twenty-four actions over news, pages and the menu. None of them can send the
email or the text message. An email reaches everyone in the register whose
address the association holds, cannot be recalled, and is claimed exactly once,
so the decision to send stays with a person on a screen: an action records a
mailing request, the board sees it on the item, and a board member publishes with
the mailing in the ordinary way.

The request is about the email specifically. `already-mailed` and the clearing
condition both read `emailQueuedAt`, so a board member who publishes with SMS
alone leaves the request standing - correctly, because what was asked for has not
happened. If SMS-only sends turn out to be common, the shape that follows is a
request that names a channel; it is not this change.

No consent attestation is ever an action input. `photoConsentConfirmed` is the
board declaring that the publication consents exist for identifiable people in a
picture, which is an attestation a person makes under GDPR and not a field a
caller fills in.

### Writes land directly, and are attributable

There is no pending-changes queue. Every action carries a `needsConfirmation`
annotation so one can be added later without changing a plugin, and MCP clients
prompt on write tools themselves.

What makes that acceptable is attribution, and attribution required three new
audit actions: `PAGE_CONTENT_CHANGED`, `NEWS_CONTENT_CHANGED` and
`PAGE_REORDERED`. Before them, five of the thirteen first-slice writes left no
record at all - publication was recorded, rewriting the body of a published page
was not. That was defensible while a board member in a browser was the only
writer.

The registry itself writes no audit entry. The service writes it, in the
transaction that made the change, with the action's own `AuditAction` value. A
generic `ACTION_INVOKED` row would throw away the per-action judgement the
enum's values encode, and would tempt a caller into putting a prompt in the
entry's context.

### Names are an interface, and a schema is a promise

An action's public name is `snake_case` ASCII and is not a domain term.
GLOSSARY.md governs what appears on a screen; a name here is a symbol a program
uses.

MCP clients cache `tools/list` at initialisation and do not refresh on a schema
change, so a name that has been offered cannot quietly start meaning something
else. `deprecatedAliases` is the mechanism for half of that: an old name is
mapped to the canonical one, resolves on dispatch and never appears in a
listing, so a rename does not strand a client that cached the old name.

It is only half, and the boundary is worth stating precisely because the
mechanism looks as though it covers more than it does. An alias dispatches to
the CURRENT definition, with the current schema. That is right for a rename,
where the schema did not change. It does nothing for a breaking input change: a
client calling the old name with the old payload would be refused by the new
schema. So a breaking change registers a new action under a new name and leaves
the old action registered, with its own schema, until the clients have moved -
or it does not ship.

Every published input schema refuses unknown keys at every depth, and the
registry converts both schemas at registration so a schema that cannot be
published is refused before anything can call it. The rule behind that is worth
stating: a `.refine()` is erased by the conversion with no marker, so a
published document can be looser than the runtime check. Structural constraints
come first, and a refine that carries a real rule gets a structural pattern
beside it.

Every refusal a bound service can raise is published with the action, carrying a
verdict - `after-edit`, `never`, `after-backoff` - and pointing at the sentence
the board's own screens already show. A caller that is a model needs to know
whether trying again could ever work; a second set of sentences written for
callers would be a second thing to keep true.

## Consequences

A capability is now checked in two places rather than one. The tests that keep
them the same decision are load-bearing, and a change to either path that is not
mirrored in the other is a defect the contract test is meant to catch.

`expectedRevision` is required on `page_update` and offered nowhere else,
because `setPublished`, `setVisibility` and `remove` accept no revision and
publishing a precondition the service discards is worse than not offering one.
Adding it to those three would change three existing HTTP routes and is the
obvious follow-up.

**The follow-up has been made, and the sentence above was narrower than it
read.** It is true of the wire and misleading about the service: `setPublished`
and `setVisibility` already did a compare-and-set on a revision they read
themselves one line earlier, and both already threw `page-changed`. What each
needed was one expression - the caller's revision where one was sent, and
otherwise the one the method read - so the whole 409 path was already there.

`remove` was the different one. It was a bare delete on a route with no body,
and no `@Delete` in this API takes one. It takes the revision as a query
parameter - `DELETE /api/site/pages/:id?expectedRevision=3` - and became a
claimed delete that raises `page-changed` when the claim matches nothing. The
alternatives were considered and rejected: a body on DELETE is legal and poorly
served by clients and proxies, and `If-Match` would bring ETag semantics this
API has nowhere else and would have to be answered for on every route that then
lacked them.

The precondition is **optional on all four actions**, which diverges from
`page_update`, where it is required. A required field added to an action that is
already armed reaches an already-connected app with no per-grant snapshot and no
reconnection step, so it is a breaking change with no migration window; and
because the catalogue asserts `additionalProperties === false`, a caller cannot
send the field ahead of the change either. Optional in both directions is the
only shape with a path through.

The same token now guards the record of processing activities, which closes
issue #125. It is a counter and not `updatedAt`, decided by the precedent
`Page.revision` set rather than by the first edit form: `@updatedAt` is stored
to the millisecond, so two saves inside one millisecond carry the same token and
the second would match the row it was meant to be refused against. The advisory
lock that method already takes answers a different question and both are needed -
the lock serialises two server transactions that overlap, and cannot see that a
payload was composed from an older read. No web form ships with it: the endpoint
has no caller, building the edit screen is a feature with its own i18n,
screenshots and end-to-end proof, and the shape the issue deferred was already
decided by the counter. The refusal reason `activity-changed` maps to 409 and
the view carries the revision; the sentence a screen shows lands with that
screen.

Two holes in the mechanism as it already stood are closed with it.
`PrivacyNoticeService.appendMissing()` was the only writer to a page outside the
page service and did not move the revision, so a board member holding the editor
open would have had their save accepted and the appended art. 13 headings
silently discarded. And `ProcessingActivityService.end()` ran its already-ended
check outside the transaction and never took the lock its sibling `update()`
takes, so an `end` could interleave inside a locked save's read-write window.
Every writer to a processing activity now moves the revision in the statement
that changes the fields, the seed included: a claim is only worth anything if
every writer a claimant races participates in it.

Seven unguarded writers were found and deliberately left alone, listed here so
the next person starts from a list rather than a survey:
`SettingsService.updateDataProtectionContacts()` and `updateMeetingBylaws()`,
`MeetingService.recordDecision()`, `AssociationFactsService.save()`,
`PagesWriteService.reorder()`, and `MenuWriteService.update|reorder|remove`.
Each is a different record with a different answer about what a conflict means,
and a change that guarded nine writers at once is a change nobody reads.

Two contracts now exist over some service methods: the action's input is
stricter than the HTTP route's in two places - a patterned slug on
`news_create`, a required revision on `page_update` - because making the routes
stricter would break a documented promise and its test.

zod is now a shared host package. This changes module resolution for every
installed plugin, not only ones declaring actions, and a plugin that bundled its
own copy now reports `module-identity` where it previously loaded.

An `AuditAction` value is now a four-file change: the Prisma enum, the API's
tuple, the browser's union and the label map. That is deliberate - it is what
makes an unlabelled action on a statutory document impossible to ship - but it
is friction every future change pays.

`ApartmentRegisterService` is on `DENIED_ACTION_SERVICES`. It writes the
termination register, the transfer reversal register and the reporting
obligation ledger, all three append-only by trigger, and no handler may be bound
to a service that writes a statutory register. `apartmentRegister:read` and
`memberRegister:read` are deliberately **not** on `DENIED_ACTION_CAPABILITIES`:
Beslutslogg 65 puts deletion from the archive tier, the reveal and the movement
of authority outside every token, and it does not put a board member's own
reading of their own register there. Denying the read capability now would
decide a later slice from inside this one, and `registerReport:export` already
exists as the capability for the act with a recipient outside the association.

The catalogue now spans two capabilities rather than one. The test that proves
dispatch and the routes decide the same thing is a table of group, controller
and expected capability, so a third capability changes a row rather than the
assertion.

Nothing revokes a token when a capability changes. A client sees a stream of
refusals rather than a clean disconnection, which is confusing and safe, and
revocation on change is named as a later change.

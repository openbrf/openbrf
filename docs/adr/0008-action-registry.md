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

`ActionsModule` is deliberately not `@Global()`. `AuditModule` and
`AuthorizationModule` are, which puts their providers in the root injector where
a loaded plugin's constructor can ask for them by type; the module seal now
refuses a plugin provider whose `design:paramtypes` name one of those. The
registry is kept out of reach by construction instead, and a plugin reaches
dispatch only through `host.actions`, which carries the plugin's identity with
it.

That check covers constructor injection. A provider resolving the same class
through `ModuleRef` at runtime is not covered, and closing it properly is its own
change.

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

Nothing revokes a token when a capability changes. A client sees a stream of
refusals rather than a clean disconnection, which is confusing and safe, and
revocation on change is named as a later change.

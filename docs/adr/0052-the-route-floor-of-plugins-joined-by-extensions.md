# ADR 0052: The route floor of plugins joined by extensions

Date: 2026-10-25

## Status

Accepted. Amends the capability floor of a plugin's routes and actions
([ADR 0003](0003-plugin-loading-and-module-resolution.md), "Routes" in
`docs/plugin-contract.md`) for plugins joined by extensions
([ADR 0030](0030-plugins-that-extend-plugins.md)). Settles how the floor meets
the resident routes of
[ADR 0051](0051-resident-routes-in-a-plugin-that-reads-the-register.md).
Extends ADR 0030's rule on groups to plugins with device routes
([ADR 0031](0031-a-device-token-for-a-plugin-s-own-routes.md)), which the
floor does not reach (amended in the change that adds that rule).

## Context

A plugin's routes are raised to a capability floor derived from its
permissions (`routeCapabilityFloor`): `addressBook:read` for either
address-book permission, and `fees:manage` with `memberCharges:manage` for a
finance permission. A plugin with none of these is held to `self:manage`,
which every account holds: the property manager, a former resident whose
account outlived their residency, and every resident. The floor exists so that
a plugin that reads the register cannot hand that reading to a caller the core
would not let read it, by mistake or otherwise.

The floor reads the plugin's own permissions and nothing else. An extension
point carries data between two plugins, and the host copies it as JSON without
reading it:

- **From an addon to its host plugin**, in a point's output. An addon that
  holds `addressBook:read` or `addressBook:readContact` can answer with a name
  or an email address in any field the point types as text, whatever the
  point's `personalData` says it accepts. The output schema checks the shape,
  not what the text is.
- **From a host plugin to its addons**, in a point's input. A host plugin can
  hand one addon what another addon answered, and an addon that extends two
  plugins carries data on from one to the other.

So a host plugin with no register permission, held to `self:manage`, can be
handed names or contacts by its addon and return them from any of its routes,
to any account. ADR 0030 already reads the plugins joined by extensions as one
group for the same reason, but only to keep `site:blocks` apart from the
register. The route floor was left out of it.

A device route has no caller to raise a floor against. ADR 0031 keeps the
register off a plugin with device routes, and lets personal data reach a
device only through an addon, at a point that may not accept contact details.
That rests on the point's `personalData`, which, as above, says what the addon
declares and not what it can answer. An addon that holds
`addressBook:readContact` or `finances:read` can extend signage and put a
resident's phone number, or what a household was charged, in a text field of
the point's output, and signage shows it on a screen in the stairwell.

The parties are the caller of a route, the residents whose details the addon
reads, the plugins of the group (each with the permissions the board consented
to for it), and the board, which consented to each plugin by itself. The board
was told, on the addon's consent screen, that the addon reads the register and
what it hands the host plugin. It was not told, and did not decide, that
every account may then read what was handed over through the host plugin's
routes, or that anyone passing a screen may.

## Options

**(a) Hold every plugin of a group to the floor its whole group's permissions
imply.** The host plugin, its addons, and any plugin joined to them through an
addon that extends two, are held to the floor of the register permissions held
anywhere among them.

**(b) Refuse the pair unless the host plugin holds the register permission
itself.** The loader would refuse an addon that reads the register when its
host plugin does not. Digital signage, the first host plugin, holds device
routes, and a plugin with device routes cannot hold an address-book permission
([ADR 0031](0031-a-device-token-for-a-plugin-s-own-routes.md)), so its
residents addon, the case ADR 0030 was written for, could never serve. A host
plugin that can hold the permission would have to ask for a reading it does not
make, which widens what it may read to close what it may return.

**(c) Raise a host plugin's floor by its own addons' permissions only.** The
pair, not the group. It covers the first path above and not the second: a host
plugin's other addons are handed the same names as a point's input, and an
addon that extends two plugins carries them to the second host plugin.

## Decision

Option (a).

### The floor

Each plugin's routes are raised to the floor that the permissions of its group
imply, by the rule `routeCapabilityFloor` already applies to one plugin. The
group is the one ADR 0030's rule reads, and the SDK exports it
(`extensionGroups`) so that the floor and that rule cannot disagree about it:
an addon and the plugins it extends, their other addons, and on through any
addon that extends two plugins. A plugin that extends nothing and is extended
by nothing is a group of one, and its floor is its own, as before.

Nothing is granted by this. No plugin receives another's permissions, as ADR
0030 promises: what rises is who may call the plugin.

The same floor holds for the plugin's actions, dispatched by the action
registry (ADR 0008), and for its view: the navigation offers it on that floor
("Where a view is found"), so a host plugin whose addon reads the register is
offered to the board and the administrator and not to a resident. A device
route (ADR 0031) is held to no floor, here as before: no person is on its
request. What a device may be shown is held by the group instead, below.

### Device routes in a group

A group never holds both a plugin that declares device routes and one that
reads more of the register than `addressBook:read` does, or proposes imports:
every permission `PERMISSION_REGISTER_ACCESS` marks as `reads` but
`addressBook:read`, which today is `addressBook:readContact` and
`finances:read`, and `addressBook:proposeImport`. This is ADR 0030's rule on
groups with a second pair of kinds, and it reads the same group. A device takes
the place of the website, and contact details, the finances and the member list
a plugin that proposes an import holds take the place of the register.

`addressBook:read` stays. Names and apartments on the screen in the entrance
are what signage's residents addon is for, ADR 0030 was written for it, and
ADR 0031 meant personal data to reach a device that way. The board reads on
the addon's consent screen that it reads the address book and hands signage
names and apartments, and consents to that. An addon that holds
`addressBook:read` can still put anything that permission reads in a text
field, such as whether a resident is a member, and the point's `personalData`
does not stop it; that is the reading the board consented to for the addon,
and catalog review reads what the addon answers.

Where a group would hold both, the loader refuses addons with
`extension-device-group-refused` until it does not, in the order of ADR 0030's
rule: among each host plugin and the addons that extend it alone, first the
addons that declare device routes, then the addons that read contact details or
the finances, or propose imports; then, across the group, the addons that join
two of its plugins. A host plugin never gives way, because its other addons
would go with it. The rule is read after ADR 0030's, among the addons
that rule left, so an addon is refused once, under the first rule it breaks.
The catalog refuses an index whose plugins would form such a group, under the
same code.

There is no rule for the pair alone, as `extension-permission-refused` is for
the website. An addon and the plugin it extends are a group of two, and the
group's refusal names both.

### Which plugins count

The groups are read at boot, from every installed plugin that is switched on
and whose consent covers what its package declares, before any plugin's code
runs. A host plugin's module is sealed with its floor before its addons are
decided, so an addon refused later in the same boot, for an unknown point or by
either rule on groups, still raises its group's floor. It is refused again on
every start while it stays installed and switched on, and raises the floor on
each, until the board switches it off or removes it and the process starts
again. This errs towards the higher floor. An addon refused for reading the
finances beside signage therefore holds signage's other routes to the board's
two money capabilities, which the board sees the refusal for. An extension that names a plugin not
installed, or switched off at boot, joins nothing.

Switching a plugin off takes effect without a restart, and the floors stay as
they were read until the next start: higher, never lower. Switching a plugin on
and installing one both restart the process, and the floors are read again.

### Resident routes

ADR 0051 lowers the floor to `self:manage` on a plugin's resident routes, and
narrows what the host object answers there. A plugin with resident routes holds
an address-book permission itself and declares no extension point, so it is in
a group only as an addon, and the address-book half of its group's floor is its
own. ADR 0051 refuses resident routes beside a finance permission because the
narrowing does not cover the books. Where the plugin's group holds one, the
finance half of the floor stays on its resident routes, and only the
address-book half is lowered. What its host plugin hands it as a point's input
arrives outside any resident route's request, and serving that from a resident
route is data carried round the route, which catalog review reads (ADR 0051,
threat 6).

## Consequences

- A host plugin whose addon reads the register is held to the board, however
  little it reads itself. No account below the floor reaches what an addon
  handed it through its routes or its actions, and its view is not offered to
  them.
- Installing an addon that reads the register raises the floor of every plugin
  in its group at the restart the install ends in. A host plugin a resident
  could use before, and its other addons, then answer only the board and the
  administrator. The addon's consent screen does not say so yet, and should.
- A group holding one plugin that reads the finances holds every member's
  routes to the board's two money capabilities.
- An addon refused at boot keeps its group's floor raised for as long as it
  stays installed and switched on.
- The floor no longer follows from one plugin's manifest alone. The loader
  computes it from the set of plugins it admits, and the action registry reads
  the floor the loader sealed the routes with.
- An addon that reads contact details or the finances, or proposes imports, does
  not serve beside signage or any other plugin with device routes, through one
  host plugin or several. One installed beside such a plugin before this rule
  is refused at the next start, and the board is told why.
- What reaches a screen through an addon is what `addressBook:read` reads, at
  most, and the point's `personalData` is the addon's declaration of what part
  of it, as before.

## Rejected alternatives

- **Refusing the pair** (option (b)). It would refuse the first addon the
  extension points were built for, and close the gap by widening the host
  plugin's own reading.
- **The pair alone** (option (c)). It leaves the input of a point and an addon
  that extends two plugins open.
- **A taint on the data an addon hands over**, carried with the value and
  checked when a route answers. The host does not see a plugin's response, so
  there is nowhere to check it, and a value copied into a string loses any mark.
- **Reading the groups after the addons are decided**, so that a refused addon
  raises nothing. The host plugins' modules are sealed first, because an addon
  whose host plugin fails to load is refused, so the floor would have to be
  raised on modules already in the graph. A floor that is too high until the
  next start fails closed, and the board sees the refusal that causes it.
- **Trusting the point's `personalData` on a device**, as ADR 0031 did. The
  output schema checks the shape of what an addon answers and not what its text
  is, so the declaration is all that stands between contact details and the
  screen.
- **Refusing every register permission beside a device route**, `addressBook:read`
  included. It would refuse signage's residents addon, which is what the board
  installs extension points for.
- **A narrower host object for an addon of a plugin with device routes**,
  which withholds contact details and the finances from it while it answers.
  What an addon hands its host plugin need not be read while it answers: it can
  read at any time and keep what it read, so the narrowing would have to cover
  the addon's every read, which is the permission it was consented to.

## Revisit triggers

- **A host plugin needs to serve residents beside an addon that reads the
  register**: resident routes on a host plugin, which ADR 0051 refuses, with
  the narrowing carried into the addon's host object (ADR 0051, "Rejected
  alternatives").
- **A floor is needed per point rather than per group**, for a host plugin
  whose points carry register data to one route and not another.
- **A device needs contact details or the finances**: the rule on device routes
  in a group would need the reason ADR 0031's revisit trigger asks for, and the
  website's rule the same reason.

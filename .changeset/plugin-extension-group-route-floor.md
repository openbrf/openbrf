---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
---

A host plugin that holds no register permission is now held to the board when
one of its addons reads the address book or the finances. An addon can hand
its host plugin a name or a contact in a point's output, and the host plugin
can pass it on to its other addons. Before this change the host plugin's routes
and actions stayed open to every account, the property manager and former
residents included. Every plugin joined by extension points now has its routes
and actions held to the capability floor of the whole group's permissions
(ADR 0052), and its view is offered in the navigation on that floor. Installing
an addon that reads the register can therefore take a host plugin, and that
host plugin's other addons, out of residents' reach.

`@openbrf/plugin-sdk` exports `extensionGroups`, the groups of plugins joined
by extensions that the group rule reads, and its `ExtensionGroupMember` type.

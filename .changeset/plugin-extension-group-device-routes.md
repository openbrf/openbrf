---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

An addon that reads contact details or the finances, or proposes imports, no
longer serves beside a plugin with device routes, such as digital signage.
A point on such a plugin accepts no contact details, but only the addon's own
declaration said what it handed over: it could answer with a phone number, or
what a household was charged, in any text field, and a screen in the stairwell
would show it. The plugins joined by extension points are now read as one group
for this as they are for the website (ADR 0052). Where a group would hold a
plugin with device routes and one that reads contact details or the finances,
or proposes imports, the loader refuses addons until it does not, the one that
reads contact details or the finances first where the other is the host plugin,
with the new finding `extension-device-group-refused`. The catalog refuses an
index that would form such a group. An addon that reads only names and apartments still
extends signage. One installed beside signage before this change is refused at
the next start, and the installed plugins screen says why.

`extensionGroupRefusals` in `@openbrf/plugin-sdk` reads each member's
`deviceRoutes`, which a caller now has to pass, and each refusal it returns
names its `reason`.

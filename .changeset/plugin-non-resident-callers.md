---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin's resident routes can serve people who do not live in the house, and
its view can be offered to every account (ADR 0053).

A manifest that declares `residentRoutes` may now declare `nonResidentCallers`,
a closed list of classes of caller those routes serve besides the residents the
address book lists: `board` (a board seat held that day), `administrator`,
`propertyManager` and `pluginAccess`. The host decides each class from its own
records, never from the plugin's. The SDK exports the list as
`PLUGIN_NON_RESIDENT_CALLERS` and the rule as `nonResidentCallerRuleIssues`.
`view.offeredTo: "signedIn"` offers the plugin's view to every signed-in account.
Both are allowed only beside resident routes.

The guard on a resident route now checks, in one query and before any of the
plugin's code runs, the three refusals first (protected personal data, a
restriction, an objection to the plugin's processing) and then whether the
person holds a residency today or is in a class the plugin declares and the
install approved. A former resident is in no class, whatever seat or role they
keep. Everybody refused gets the same 403 with reason
`resident-route-not-listed` and the same wording as before. The navigation
offers such a plugin's view on the same terms, without the three refusals.

The install records the classes it approved, and a version that declares a
class outside them is refused at load as `resident-routes-widened`. No install
approves a class yet: the catalog index and the consent screen that carry the
classes follow, and until then every plugin is served exactly as before. The
`pluginAccess` class serves nobody until the core keeps plugin accesses.

A plugin built for this should not declare either field until the instances it
serves run this release. An earlier instance ignores both, serves the listed
residents alone and offers the view only to them.

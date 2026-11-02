---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The plugin SDK can declare who a plugin's resident routes serve besides the
residents the address book lists to it (ADR 0053). This change covers the
contract and the consent screen's text.

- **Manifest.** `nonResidentCallers` lists any of `board`, `administrator`,
  `propertyManager` and `pluginAccess`, at least one and each once, and only
  beside `residentRoutes`. `view.offeredTo: "signedIn"` offers the view to
  every account, only beside `residentRoutes` and in a named section. A
  collection of `personRecords` may declare `showsSubject`. Then a record's
  subject can choose to have their name shown to the others the plugin serves.
  `nonResidentCallerRuleIssues` holds the rules, and the manifest and the
  catalog index share it.
- **Types.** `PLUGIN_NON_RESIDENT_CALLERS`, `PluginNonResident`, the
  `nonResident` answer of `host.addressBook.caller`, an optional
  `host.addressBook.nonResidents()`, `showSubject` on a record a plugin writes,
  and `showSubject` and `shown` on a record it reads. A plugin checks that
  `nonResidents` exists before it calls it.
- **Data subjects.** `processingDataSubjects` adds board members for `board`.
  It adds people outside the association for `administrator`,
  `propertyManager` and `pluginAccess`. The consent screen,
  `openbrf plugin add` and the plugin's row in the record of processing
  activities name them after the declared categories. Neither is a value of
  `dataSubjects`, so a
  manifest has nothing new to declare. An instance released before this one
  would refuse such a value.
- **Catalog index version 4.** It adds `nonResidentCallers` to a plugin entry
  and `showsSubject` to a collection. Versions 1 to 3 refuse both, so a catalog
  keeps serving version 3 without those entries.
- **Consent screen.** After the resident routes, the consent screen and
  `openbrf plugin add` name each declared class. They say that the refusals
  for protected personal data, a restriction and an objection still hold, what
  the plugin can read of these people and what they see. When the property
  manager is declared, they also say what the association's processor agreement
  has to cover. A collection that declares `showsSubject` says so. The sentence
  about what a record names now says "one person" rather than "one resident".

An instance released before this one ignores `nonResidentCallers` and
`offeredTo`, and serves the listed residents alone. It refuses a manifest whose
collection declares `showsSubject`, because it reads a collection strictly.

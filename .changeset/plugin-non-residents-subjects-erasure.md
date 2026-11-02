---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin can read, name and mail the people its resident routes serve who do
not live here, and a plugin access keeps its holder in the register while it
stands (ADR 0053).

- `host.addressBook.nonResidents()` lists the persons a plugin serves who hold
  no residency today. These are the board members and administrators who live
  elsewhere and the property manager, each for a class the manifest declares
  under `nonResidentCallers` and the install consented to. The `pluginAccess`
  class does not serve anybody yet, so a holder of a plugin access is not
  listed, answered as `nonResident` or accepted as a record's subject for it. Protected personal data, a restriction and an objection to the
  plugin's processing leave a person out, as in `residents()`, and so does
  having moved out. Contact details are given on the terms of `residents()`.
  It needs `addressBook:read`. On a resident route it is refused with
  `PluginResidentRouteError`, as the other register reads are. `summary()`
  does not count these persons.
- `host.addressBook.caller` answers `nonResident` for such a person, without
  naming the class. A plugin that declares no class never gets that answer.
- A new record about a person, and an audit entry naming one, may name any
  person the plugin serves, not only a resident. So the board can assign a
  parking space to somebody who rents a garage, on a board route. A record
  keeps its subject when rewritten after that person has moved out or left the
  class. On a resident route the rule is unchanged: a new record names the
  caller.
- While a plugin access stands, the board cannot grant an erasure of its
  holder. The person's page gives the reason in Swedish and English, and no
  purge erases the person. Once the board withdraws the access, an erasure can
  be granted and is carried out, the plugin's records about the person
  included. A person who has only held a plugin access has never had a
  residency to count a retention period from, so the scheduled purge gives them
  no date. A granted erasure removes them, as it removes a board member who
  lives elsewhere once their term has ended.

---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A plugin can now say in its manifest that it handles free text, charges,
photographs and the other personal-data categories the association's record
of processing activities uses, not only names, apartments, residency, email and phone.

A plugin that calls actions handles whatever those actions return. An assistant
that passes issue reports and minutes to a model provider handles what people
wrote, and its manifest could not say so before. The install consent screen and
the record of processing activities written at install therefore said less than
the plugin handled. Both now show the new categories, in Swedish and in English.

`personalData` in a manifest and in a catalog entry takes `postalAddress`,
`account`, `financial`, `health`, `photograph`, `freeText` and `auditTrail`, as
well as the five it took before. `personalIdentityNumber` and `protected` are
refused: no plugin is ever given a personal identity number or a person with
protected personal data. The catalog index stays at version 1. An instance
older than this one refuses the whole catalog index if one entry names a new
category.

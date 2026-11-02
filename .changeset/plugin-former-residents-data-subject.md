---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin's processing declaration can name former residents. `dataSubjects`
accepts `formerResidents` beside `members` and `residents`, and the record of
processing activities records it as former residents, the category the core's
own processing already uses.

A plugin that keeps records about a person (`personRecords`) is shown and
recorded with former residents whether it names them or not. A person who moves
out keeps those records until each one's erase date, and they stay on the
person's access report, so the consent screen, `openbrf plugin add` and the
plugin's row in the record of processing activities now name former residents
after the categories the plugin declared. The SDK exports this as
`processingDataSubjects`. A row seeded earlier keeps its categories until the
plugin is installed or updated again, and a row the board has edited keeps the
board's words.

Plugins do not have to declare the new value, and should not until the
instances they serve run this release: an instance released earlier refuses a manifest that uses
it, and refuses the whole catalog index if an entry uses it. ADR 0035 records
the decision.

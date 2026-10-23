---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A plugin's writes to `host.records` now wait their turn in the instance's own
process, so a burst of them holds one database connection at a time instead of
one each, and can no longer take the connections every other request needs.

Installing a plugin whose catalog entry names a different package than the one
installed under the same id is now refused with the reason
`plugin-package-changed`. The other package would have taken over the installed
plugin's settings, records and device tokens. The plugin screen says to remove the installed
plugin first, which deletes them.

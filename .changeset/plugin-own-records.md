---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A plugin can now keep state of its own. `host.records` stores JSON values under
a collection and a key, belonging to the plugin and to nothing else: `get`,
`list` in key order, `put` and `delete`, each write with an optional
compare-and-set on the record's `revision`. It needs no permission. A value is
at most 64 KiB, and a plugin holds at most 10 000 records and 16 MiB in all.

The records are for configuration, such as a list of screens, and never for
people, because the access report, purging and erasure cannot see into them. A
write carrying a personal identity number is refused, as on a page. Switching a
plugin off keeps its records and closes them to it; removing a plugin deletes
them, and the remove screen now says so before the board confirms. See ADR 0033.

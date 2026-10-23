---
"@openbrf/api": patch
"@openbrf/plugin-sdk": patch
"@openbrf/i18n": patch
---

A plugin's writes to `host.records` that wait their turn are now held to 100 per
plugin, the one under way and those waiting. A write sent past that throws
`PluginRecordLimitError` with the `limit` `queuedWrites`, and nothing is
written, so a plugin that writes faster than the database lands them can no
longer grow the instance's memory without bound.

The refusal shown when a catalog entry names another package under the id of an
installed plugin now calls what is deleted with the plugin its settings and
configuration records, as the remove screen does. The plugin contract also tells
whoever curates a catalog that a package renamed under an existing id strands
the instances that run it, and that it should take a new id instead.

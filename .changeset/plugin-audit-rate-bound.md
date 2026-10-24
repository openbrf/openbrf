---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

`host.audit.record` now limits how fast a plugin writes audit entries, with two
token budgets that each hold a burst and refill continuously; an entry refused
for breaking a bound spends from neither. Entries on one person's requests
share a burst of 30 with each plugin, refilling at 30 a minute
(`PLUGIN_AUDIT_LIMITS.perPersonPerMinute`). The entry past it is refused with
the new `PluginAuditRateError`, nothing is written, and the plugin keeps
running, so no member can stop a plugin for everyone by making it audit them.
Entries with no request, from the plugin's own jobs, share a burst of 120,
refilling at 120 a minute (`PLUGIN_AUDIT_LIMITS.perMinute`). A plugin that
writes past that is stopped with the new finding `audit-rate-exceeded`: the
entry is refused and nothing is written, and every host service refuses the
plugin until the application restarts, which switching the plugin off and on
again does. The admin screen says why it stopped. Before this, a plugin writing
in a loop could grow the audit log without bound, since an entry needs no
permission and no purge removes it.

The data subject access report now prints a plugin's text for an event as the
plugin wrote it, with no interpolation or nesting, and cuts it at 200
characters. A `$t()` in that text could otherwise print the core's words, or
another plugin's, as the plugin's own.

The record of processing activities now says when a plugin's row names no
personal data: this record lists no categories, which does not mean the plugin
handles none. Before, the list was empty, which read as a processing of no
personal data at all.

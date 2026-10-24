---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

A plugin's writes through `host.audit.record` are now rate-bound
(`PLUGIN_AUDIT_LIMITS.perMinute`): a budget of 120 entries that refills at 120
a minute, so a plugin can write 120 at once and then as many as the budget has
refilled. An entry refused for breaking a bound does not count. A plugin
that writes past it is stopped with the new finding `audit-rate-exceeded`: the
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

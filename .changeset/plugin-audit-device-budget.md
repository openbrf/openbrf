---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
---

`host.audit.record` takes the request one of the plugin's device routes
received. The entry has no actor, since a device names nobody, and each device
spends a budget of its own with the plugin: a burst of 30, refilling at 30 a
minute (`PLUGIN_AUDIT_LIMITS.perDevicePerMinute`). The entry past it is refused
with `PluginAuditRateError`, nothing is written, and the plugin keeps running.
Before this, a device's request was refused, and a plugin auditing on a device
route could only write an entry with no request: every call the device made then
spent the plugin's own budget, and whoever held a device's token could stop the
plugin for everyone by calling the route fast enough. A device's request whose
response has been sent is refused, as a person's is. The contract now says not
to write an entry with no request for each call a route answers.

---
"@openbrf/plugin-sdk": minor
---

The SDK exports `PluginRequestContextError` and `PLUGIN_REQUEST_MEMBERS`. A host
raises the error when a plugin gives one of the members that take a request a
request that the work making the call is not serving: `addressBook.caller`,
`actions.list`, `invoke`, `propose` and `client`, `audit.record` with a
request, `themes.install`, and `devices.issue`, `revoke` with a request, and
`current`. The error carries the plugin's id and the member, and its message
names neither the request nor a person. The `PluginHost` documentation states
the rule.

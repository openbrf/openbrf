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
the rule. The README and the documentation of `PLUGIN_API_VERSION` now state
the one case in which a change a plugin can notice keeps the API version: a
security fix that only refuses a use of the host beyond what the contract
grants, where raising the version would refuse to load every plugin built
against it.

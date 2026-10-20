---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

An audit entry written by a plugin's dispatch now names the plugin. When a
plugin's route dispatches an action, the entry records the plugin's id beside
the person and the channel, whatever the channel is. A signed-in person's
request on the plugin's route is recorded on the `plugin` channel. A connected
app's token on that route is recorded on `mcp`, and the entry now names both the
app and the plugin. The host supplies the id from the plugin's manifest, so a
plugin cannot name another plugin.

The data subject access report prints the plugin under the channel in its
"Via" column. A `plugin` or `ai` entry written before this change says that the
plugin was not recorded at the time.

The SDK's `ActionContext` gains an optional `pluginId`, so an action's handler
can tell when a plugin's route made the call. One migration adds a nullable
column to the audit log. It has no default and fills in no older rows.

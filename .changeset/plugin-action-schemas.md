---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
---

A plugin can now read the schemas of the actions its route may offer.
`host.actions.describe(request, filter)` answers what `host.actions.list` does,
with each action's input and output JSON Schema, so a connector that speaks MCP
can build its tool listing in process. The SDK exports the `ActionDescription`
type it returns.

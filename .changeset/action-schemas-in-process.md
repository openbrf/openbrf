---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
---

`host.actions.list` hands a plugin each listed action's input and output JSON
Schema, `inputSchema` and `outputSchema`, as the HTTP catalogue publishes them
for one action (ADR 0038). A connector can build `tools/list`, and an AI package
can describe a tool to a model, without calling its own instance over HTTP.
Only the actions listed carry one, filtered by channel, surface, capability,
liveness and arming, as `invoke` is. Token scope and read-only mode are decided
at `invoke`, which may still refuse a listed action. The SDK exports the entry's type as
`ActionWithSchemas`.

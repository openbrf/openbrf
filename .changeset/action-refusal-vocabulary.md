---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

A plugin that dispatches an action can now tell why the call was refused. The
SDK exports the registry's refusal vocabulary, `ACTION_ERROR_REASONS`, and
`ACTION_ERROR_MCP`, the table that says whether a connector renders each refusal
as a protocol error or as a tool result and whether trying again could work. The
API now reads both from the SDK, so the catalogue endpoint and a plugin read the
same list.

`host.actions.invoke` now rejects a refused call with an `ActionRefusal`, one
shape for the registry's own refusals, an input the action's schema refuses and
a refusal from the service behind the action, and `isActionRefusal` recognises
one. It carries the reason, the status, how to render it, the retry verdict and
the particulars, and for a token missing a scope the bearer challenge a
connector sends back so the client can ask for that scope. Before this a plugin
received the host's own error classes, which it cannot import. A plugin route
that rethrows the refusal answers with the status and headers the registry would
have, and an invalid body is now answered with a 400 there rather than as the
plugin's failure.

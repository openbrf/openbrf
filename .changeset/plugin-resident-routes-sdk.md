---
"@openbrf/plugin-sdk": minor
---

A plugin manifest can now declare `residentRoutes`: paths under the plugin's
own mount that a resident may call without a board seat, although the plugin
reads the register (ADR 0051). Each route has a `path`, written as a device
route's is, and a `titleKey` in the plugin's own namespace. A plugin declares
at most eight, and no two may overlap.

The manifest refuses the declaration unless the plugin asks for
`addressBook:read` or `addressBook:readContact`. It also refuses it beside
`finances:read` or `finances:recordDelivery`, beside a view in the `board`
section, beside an extension point, and on a path that overlaps
`oauthProtectedResource`. The manifest and the catalog index hold an entry to
these rules through one function, `residentRouteRuleIssues`.

The catalog index carries the routes in a new version 3, each with its path and
the curator's title in Swedish and English. Version 2 shipped in a core release
that reads it strictly, so the field could not join it. Versions 1 and 2 refuse
the field.

The SDK also exports the `PluginResidentRoute` type and
`PluginResidentRouteError`. A host that implements resident routes raises the
error when a resident route reads the register, or when it passes `caller` or
an action dispatch a request other than the one it is serving.

This release only declares the routes. A host that does not yet implement
them keeps every route at the plugin's capability floor, and does not offer
the plugin's view to residents.

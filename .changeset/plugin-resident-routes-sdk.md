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
`oauthProtectedResource`. The manifest and the catalog index share these rules
through one function, `residentRouteRuleIssues`, and each applies the ones it
has the data for. A catalog entry carries no view, so the rule on the `board`
section is checked through the package's manifest, not the index.

The catalog index carries the routes in a new version 3, each with its path and
the curator's title in Swedish and English. Version 2 shipped in a core release
that reads it strictly, so the field could not join it. Versions 1 and 2 refuse
the field.

The SDK also exports the `PluginResidentRoute` type and
`PluginResidentRouteError`. A host that implements resident routes raises the
error when a resident route reads the register, or when it passes `caller`, an
action dispatch (`actions.list`, `invoke` or `propose`) or `audit.record` a
request other than the one it is serving, and the same for `actions.client`
and `themes.install`. It raises it with `outside` set when the plugin makes
one of those calls, a `personRecords.put` or a `recipients.fetch` naming
persons outside its resident routes, and a resident route that was already
being served does not answer in time, or has not stopped working within a
bounded overrun after its deadline. `actions.client` is the exception: made
outside a resident route it neither waits nor is refused for a route that has
yet to answer, as it only checks the route it is called in.

This release only declares the routes. A host that does not yet implement
them keeps every route at the plugin's capability floor, and does not offer
the plugin's view to residents.

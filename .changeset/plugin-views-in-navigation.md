---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
---

A plugin's view can now be offered in the application's navigation. The
manifest's `view` takes an optional `section` - `association`, `building`,
`board` or `settings` - and the view's entry stands in that section after the
core's own destinations, under the view's title, in the band and in the phone's
menu. A view that names no section is reachable by its address alone, as
before, so existing plugins need no change.

Naming a section asks for an entry rather than granting one. The entry is
offered only to an account that holds what the plugin's routes require, and in
the board's section only to the board and the administrator. `GET
/api/plugin-views` now carries, for each view, the `section` the asking account
is offered it in, or `null`. The SDK exports `PLUGIN_VIEW_SECTIONS`,
`PluginViewSection`, `pluginViewSchema` and `PluginView`.

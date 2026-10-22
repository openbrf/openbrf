---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

A plugin's controller can now raise a route above its capability floor with
`RequireCapability`, exported from `@openbrf/plugin-sdk` with the metadata key
it writes (`REQUIRED_CAPABILITIES_KEY`) and the capability names a route may
require (`PLUGIN_ROUTE_CAPABILITIES`, `PluginRouteCapability`). Before this a
plugin had to set the key itself with `SetMetadata`. The API's own decorator is
the same one, so the two cannot disagree on the key.
